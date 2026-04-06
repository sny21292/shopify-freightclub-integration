const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const logger = require('../utils/logger');
const freightclub = require('../services/freightclub');
const shopify = require('../services/shopify');

// File-based persistent storage for active shipments
const DATA_FILE = path.join(__dirname, '..', 'data', 'active-shipments.json');

/**
 * Load active shipments from disk.
 * Format: { [shipmentId]: { shopifyOrderId, shopifyOrderName, shippingTier, createdAt } }
 */
function loadShipments() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    logger.error('Failed to load active shipments file', { message: err.message });
  }
  return {};
}

/**
 * Save active shipments to disk.
 */
function saveShipments(shipments) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(shipments, null, 2));
  } catch (err) {
    logger.error('Failed to save active shipments file', { message: err.message });
  }
}

/**
 * Register a shipment to be polled for tracking updates.
 *
 * @param {string} shipmentId - FreightClub ShipmentNumber
 * @param {Object} orderInfo  - { shopifyOrderId, shopifyOrderName, shippingTier }
 */
function trackShipment(shipmentId, orderInfo) {
  const shipments = loadShipments();
  shipments[shipmentId] = {
    ...orderInfo,
    createdAt: new Date().toISOString(),
  };
  saveShipments(shipments);
  logger.info('Shipment added to tracking poller', { shipmentId, ...orderInfo });
}

/**
 * Remove a shipment from the active poll list (e.g. after delivery or fulfillment).
 */
function untrackShipment(shipmentId) {
  const shipments = loadShipments();
  delete shipments[shipmentId];
  saveShipments(shipments);
  logger.info('Shipment removed from tracking poller', { shipmentId });
}

/**
 * Core polling logic — called once per cron tick.
 * Iterates over every active shipment and checks for tracking numbers.
 *
 * FreightClub creates tracking numbers when a shipment is booked in the dashboard.
 * We poll to detect when tracking becomes available, then push it back to Shopify.
 */
async function pollActiveShipments() {
  const shipments = loadShipments();
  const ids = Object.keys(shipments);

  logger.info('Tracking poll cycle started', { count: ids.length });

  if (ids.length === 0) {
    logger.info('No active shipments to poll');
    return;
  }

  // Clean up stale shipments that have been sitting for over 30 days without being booked (no tracking after 30 days = likely never booked)
  const MAX_AGE_DAYS = 30;
  const now = Date.now();
  let staleCount = 0;

  for (const shipmentId of ids) {
    const info = shipments[shipmentId];
    if (info.createdAt) {
      const ageDays = (now - new Date(info.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > MAX_AGE_DAYS && !info.trackingSaved) {
        logger.warn('Removing stale shipment — no tracking after 30 days (likely never booked)', {
          shipmentId,
          shopifyOrderId: info.shopifyOrderId,
          shopifyOrderName: info.shopifyOrderName,
          createdAt: info.createdAt,
          ageDays: Math.round(ageDays),
        });
        delete shipments[shipmentId];
        staleCount++;
        continue;
      }
    }
  }

  if (staleCount > 0) {
    saveShipments(shipments);
    logger.info('Stale shipments cleaned up', { removed: staleCount });
  }

  // Re-get the list after cleanup
  const activeIds = Object.keys(shipments);
  if (activeIds.length === 0) {
    logger.info('No active shipments to poll after cleanup');
    return;
  }

  for (const shipmentId of activeIds) {
    const info = shipments[shipmentId];

    try {
      const tracking = await freightclub.getTracking(shipmentId, {
        customerNumber: info.shopifyOrderNumber,
      });

      // FreightClub returns an array of tracking events, sorted chronologically.
      // When querying by customerNumber, FC may return events from multiple shipments
      // (e.g. if the same PO was reused). Filter to the most recent ShipmentNumber.
      const allEvents = Array.isArray(tracking) ? tracking : [];
      const latestShipmentNum = allEvents.reduce(
        (max, e) => Math.max(max, e.ShipmentNumber || 0), 0
      );
      const events = allEvents.filter(
        (e) => e.ShipmentNumber === latestShipmentNum
      );

      if (!events.length) {
        logger.debug('No tracking events yet for shipment', { shipmentId });
        continue;
      }

      // Find the real carrier tracking number (skip FC internal numbers like FCUPSG...)
      // The carrier tracking number appears on events after the first "Booked" event
      const carrierEvent = events.find(
        (e) => e.TrackingNumber && !e.TrackingNumber.startsWith('FC')
      );
      const trackingNumber = carrierEvent?.TrackingNumber || events[0]?.TrackingNumber;

      if (!trackingNumber) {
        logger.debug('No tracking number yet for shipment', { shipmentId });
        continue;
      }

      // Extract carrier info from the first event (has CarrierCode)
      const carrierCode = events[0]?.CarrierCode || '';
      // Carrier names must match Shopify's recognized list exactly so Shopify
      // auto-tracks shipments and sends status update emails to customers.
      const carrierMap = {
        UPSG: 'UPS',
        UPSF: 'UPS',
        FDXG: 'FedEx',
        FDXF: 'FedEx',
        ESTS: 'Estes',
      };
      const carrier = carrierMap[carrierCode] || carrierCode || 'FreightClub';

      // Build tracking URL based on carrier
      let trackingUrl = '';
      if (carrierCode?.startsWith('UPS')) {
        trackingUrl = `https://www.ups.com/track?tracknum=${trackingNumber}`;
      } else if (carrierCode?.startsWith('FDX') || carrierCode?.startsWith('FED')) {
        trackingUrl = `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
      }

      // Get latest status
      const latestEvent = events[events.length - 1];
      const latestStatus = latestEvent?.Description || 'Unknown';
      const trackingCategory = latestEvent?.TrackingCategory || '';

      logger.info('Tracking number found!', {
        shipmentId,
        trackingNumber,
        carrier,
        latestStatus,
        trackingCategory,
        totalEvents: events.length,
        shopifyOrderId: info.shopifyOrderId,
      });

      // Save tracking info to Shopify order metafields as soon as we detect it
      // (so the team can see tracking on the order before delivery)
      if (!info.trackingSaved) {
        try {
          await shopify.updateOrderMetafield(info.shopifyOrderId, 'fc_tracking_number', trackingNumber);
          await shopify.updateOrderMetafield(info.shopifyOrderId, 'fc_carrier', carrier);
          if (trackingUrl) {
            await shopify.updateOrderMetafield(info.shopifyOrderId, 'fc_tracking_url', trackingUrl);
          }

          // Mark as saved so we don't re-write every poll cycle
          shipments[shipmentId].trackingSaved = true;
          saveShipments(shipments);

          logger.info('Tracking info saved to Shopify order metafields', {
            shipmentId,
            shopifyOrderId: info.shopifyOrderId,
            trackingNumber,
            carrier,
          });
        } catch (err) {
          logger.error('Failed to save tracking metafields to Shopify order', {
            shipmentId,
            shopifyOrderId: info.shopifyOrderId,
            message: err.message,
          });
        }
      }

      // Fulfill as soon as we have a real tracking number so Shopify triggers
      // the full customer email chain: Shipping confirmation → Out for delivery → Delivered.
      // Shopify auto-polls the carrier for status updates after fulfillment.
      if (!info.fulfilled) {
        try {
          // Check if order was already fulfilled on Shopify (e.g. manually by Cole's team)
          const order = await shopify.getOrder(info.shopifyOrderId);
          if (order.fulfillment_status === 'fulfilled') {
            logger.info('Order already fulfilled on Shopify (likely manual) — skipping', {
              shipmentId,
              shopifyOrderId: info.shopifyOrderId,
              shopifyOrderName: info.shopifyOrderName,
            });
            shipments[shipmentId].fulfilled = true;
            saveShipments(shipments);
          } else {
            await shopify.fulfillOrder(info.shopifyOrderId, {
              tracking_number: trackingNumber,
              tracking_url: trackingUrl,
              tracking_company: carrier,
            });

            shipments[shipmentId].fulfilled = true;
            saveShipments(shipments);

            logger.info('Shopify order fulfilled with tracking — customer shipping emails will be sent by Shopify', {
              shopifyOrderId: info.shopifyOrderId,
              shopifyOrderName: info.shopifyOrderName,
              trackingNumber,
              carrier,
            });
          }
        } catch (err) {
          logger.error('Failed to fulfill Shopify order', {
            shipmentId,
            shopifyOrderId: info.shopifyOrderId,
            message: err.message,
          });
        }
      }

      // Check if delivered — if so, remove from polling (nothing left to do)
      const isDelivered = events.some(
        (e) => (e.TrackingCategory || '').toLowerCase().includes('delivered') ||
               (e.Description || '').toLowerCase().includes('delivered')
      );

      if (isDelivered) {
        logger.info('Shipment delivered — removing from tracking poller', {
          shipmentId,
          shopifyOrderId: info.shopifyOrderId,
          shopifyOrderName: info.shopifyOrderName,
        });
        untrackShipment(shipmentId);
      } else {
        logger.info('Shipment in transit — continuing to poll', {
          shipmentId,
          latestStatus,
          trackingCategory,
        });
      }
    } catch (error) {
      // 400 = shipment not yet booked on FC dashboard, expected for unbooked quotes
      if (error.response?.status === 400) {
        logger.info('Shipment not yet booked on FreightClub — no tracking available', {
          shipmentId,
          shopifyOrderId: info?.shopifyOrderId,
          shopifyOrderName: info?.shopifyOrderName,
        });
      } else {
        logger.error('Tracking poll error for shipment', {
          shipmentId,
          shopifyOrderId: info?.shopifyOrderId,
          message: error.message,
          status: error.response?.status,
        });
      }
      // Continue polling other shipments even if one fails
    }
  }

  logger.info('Tracking poll cycle complete');
}

/**
 * Start the cron scheduler.
 * Default: every hour (0 * * * *) via TRACKING_POLL_INTERVAL env var.
 */
function start() {
  const schedule = process.env.TRACKING_POLL_INTERVAL || '0 * * * *';

  if (!cron.validate(schedule)) {
    logger.error('Invalid cron schedule, poller not started', { schedule });
    return;
  }

  cron.schedule(schedule, pollActiveShipments);
  logger.info('Tracking poller started', { schedule });

  // Log how many shipments are being tracked on startup
  const shipments = loadShipments();
  const count = Object.keys(shipments).length;
  if (count > 0) {
    logger.info('Resuming tracking for existing shipments', { count });
  }
}

module.exports = {
  start,
  trackShipment,
  untrackShipment,
  pollActiveShipments,
};
