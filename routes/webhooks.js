const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const logger = require('../utils/logger');
const freightclub = require('../services/freightclub');
const shopify = require('../services/shopify');
const notification = require('../services/notification');
const trackingPoller = require('../cron/trackingPoller');

const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

/**
 * Verify Shopify webhook HMAC signature.
 * Uses the raw body (Buffer) captured by the verify callback in server.js.
 */
function verifyShopifyHmac(req, res, next) {
  if (!WEBHOOK_SECRET) {
    logger.warn('SHOPIFY_WEBHOOK_SECRET not set — skipping HMAC verification');
    return next();
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) {
    logger.warn('Missing X-Shopify-Hmac-SHA256 header — dumping all headers for debug', {
      headers: Object.keys(req.headers),
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Debug: log raw body info to verify it's captured correctly
  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.warn('HMAC check: rawBody is missing — body parsing may have consumed it', { path: req.path });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const computed = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');

  logger.info('HMAC debug', {
    path: req.path,
    receivedHmac: hmacHeader.substring(0, 10) + '...',
    computedHmac: computed.substring(0, 10) + '...',
    rawBodyType: typeof rawBody,
    rawBodyIsBuffer: Buffer.isBuffer(rawBody),
    rawBodyLength: rawBody.length,
    secretPrefix: WEBHOOK_SECRET.substring(0, 8) + '...',
  });

  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(computed, 'base64'),
      Buffer.from(hmacHeader, 'base64')
    );
    if (!valid) {
      logger.warn('Invalid HMAC signature on webhook', { path: req.path });
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch (err) {
    logger.warn('HMAC comparison failed', { path: req.path, message: err.message });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  logger.info('HMAC verification passed', { path: req.path });
  next();
}

// Turn Offroad warehouse — 1791 3rd St, Riverside, CA 92507
const WAREHOUSE_ORIGIN = {
  zip: '92507',
  city: 'Riverside',
  state: 'CA',
  country: 'US',
  locationType: 'Commercial',
  locationName: 'Turn Offroad Warehouse',
};

/**
 * Determine if a product is freight-eligible by checking its tags.
 * Products tagged "Freightclub" (case-insensitive) go through FreightClub.
 * Everything else is handled by ShipStation via its existing Shopify integration.
 *
 * @param {string} tags - Comma-separated product tags from Shopify
 * @returns {boolean}
 */
const FREIGHT_TAGS = ['oversize ground'];

function hasFreightclubTag(tags) {
  if (!tags) return false;
  const productTags = tags.split(',').map((t) => t.trim().toLowerCase());
  return productTags.some((tag) => FREIGHT_TAGS.includes(tag));
}

/**
 * Detect which shipping tier the customer selected at checkout.
 * Managed by the Intuitive Shipping app on Shopify:
 *   - "Free Freight Shipping" → Standard (economy LTL, 8-12 days)
 *   - "Premier Carrier Delivery" → Premier (FedEx Freight / Estes, 4-7 days, $250)
 *
 * @param {Array} shippingLines - order.shipping_lines from Shopify
 * @returns {string} "Standard" | "Premier" | "Unknown"
 */
function detectShippingTier(shippingLines) {
  if (!shippingLines?.length) return 'Unknown';

  for (const line of shippingLines) {
    const title = (line.title || '').toLowerCase();
    if (title.includes('premier')) return 'Premier';
    if (title.includes('freight') || title.includes('free')) return 'Standard';
  }

  return 'Unknown';
}

/**
 * POST /api/webhooks/shopify-order
 *
 * Receives Shopify's orders/create webhook. Inspects line items for products
 * tagged "Freightclub". If found:
 *   1. Fetches product dimensions from Shopify metafields
 *   2. Calls FreightClub Get Rates API (creates shipment + returns quotes)
 *   3. Sends notification to Cole's team with order details + dashboard link
 *   4. Registers shipment for tracking polling
 */
router.post('/shopify-order', verifyShopifyHmac, async (req, res) => {
  try {
    // Acknowledge immediately so Shopify doesn't retry
    res.status(200).json({ received: true });

    const order = req.body;
    logger.info('Received Shopify order webhook', {
      orderId: order.id,
      orderNumber: order.order_number,
      orderName: order.name,
    });

    // ---------------------------------------------------------------
    // Step 1: Check for freight-eligible items (tagged "Freightclub")
    // ---------------------------------------------------------------
    // Shopify line_items don't include product tags directly in the webhook,
    // so we need to fetch each unique product to check tags.
    const productIds = [
      ...new Set(
        (order.line_items || [])
          .map((li) => li.product_id)
          .filter(Boolean)
      ),
    ];

    // Fetch products in parallel and build a tag lookup
    const productTagMap = {};
    await Promise.all(
      productIds.map(async (productId) => {
        try {
          const product = await shopify.getProduct(productId);
          productTagMap[productId] = product.tags || '';
        } catch (err) {
          logger.error('Failed to fetch product for tag check', {
            productId,
            message: err.message,
          });
          productTagMap[productId] = '';
        }
      })
    );

    // Filter line items to only freight-eligible ones
    const freightItems = (order.line_items || []).filter((li) =>
      hasFreightclubTag(productTagMap[li.product_id])
    );

    if (!freightItems.length) {
      logger.info('No freight-eligible items in order — ShipStation handles it', {
        orderId: order.id,
      });
      return;
    }

    logger.info('Freight-eligible items found', {
      orderId: order.id,
      count: freightItems.length,
      skus: freightItems.map((li) => li.sku),
    });

    // ---------------------------------------------------------------
    // Step 2: Fetch product dimensions from Shopify metafields
    // ---------------------------------------------------------------
    const boxes = [];
    for (const li of freightItems) {
      let length = 0, width = 0, height = 0;

      try {
        // Try product-level metafields first (confirmed approach with client)
        const metafields = await shopify.getVariantMetafields(li.variant_id);
        logger.info('Variant metafields received', {
          variantId: li.variant_id,
          metafields: metafields.map((mf) => ({ namespace: mf.namespace, key: mf.key, value: mf.value })),
        });
        const meta = {};
        for (const mf of metafields) {
          meta[mf.key] = mf.value;
        }
        length = parseFloat(meta.length) || 0;
        width = parseFloat(meta.width) || 0;
        height = parseFloat(meta.height) || 0;
        logger.info('Parsed dimensions', { variantId: li.variant_id, length, width, height });
      } catch (err) {
        logger.warn('Could not fetch metafields for variant, using defaults', {
          variantId: li.variant_id,
          message: err.message,
        });
      }

      // Skip items without dimensions — can't get accurate rates
      if (!length || !width || !height) {
        logger.warn('Skipping item — dimensions not set in metafields', {
          variantId: li.variant_id,
          sku: li.sku,
          length, width, height,
        });
        continue;
      }

      // Weight: Shopify webhook sends grams, convert to lbs
      const weightLbs = li.grams ? li.grams / 453.592 : 0;

      const itemPrice = parseFloat(li.price) || 0;

      boxes.push({
        description: li.title || li.name || '',
        sku: li.sku || '',
        qty: li.quantity || 1,
        weight: Math.round(weightLbs) || 1, // minimum 1 lb
        length,
        width,
        height,
        declaredValue: itemPrice * (li.quantity || 1),
        category: 'GeneralCommodity',
      });
    }

    if (!boxes.length) {
      logger.warn('No items with valid dimensions — skipping FreightClub rate request', {
        orderId: order.id,
      });
      return;
    }

    // ---------------------------------------------------------------
    // Step 3: Detect shipping tier
    // ---------------------------------------------------------------
    logger.info('Raw shipping_lines from order', {
      orderId: order.id,
      shippingLines: (order.shipping_lines || []).map(sl => ({
        title: sl.title,
        code: sl.code,
        source: sl.source,
        price: sl.price,
      })),
    });
    let shippingTier = detectShippingTier(order.shipping_lines);

    // Fallback: if shipping_lines was empty in the webhook, re-fetch the order
    // from Shopify API after a short delay (Shopify sometimes fires the webhook
    // before shipping_lines is fully populated)
    if (shippingTier === 'Unknown') {
      logger.info('Shipping tier unknown — re-fetching order from Shopify API', { orderId: order.id });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const freshOrder = await shopify.getOrder(order.id);
        const freshTier = detectShippingTier(freshOrder.shipping_lines);
        logger.info('Re-fetched shipping_lines', {
          orderId: order.id,
          shippingLines: (freshOrder.shipping_lines || []).map(sl => ({
            title: sl.title,
            code: sl.code,
            source: sl.source,
            price: sl.price,
          })),
          freshTier,
        });
        if (freshTier !== 'Unknown') {
          shippingTier = freshTier;
        }
      } catch (err) {
        logger.warn('Failed to re-fetch order for shipping tier fallback', {
          orderId: order.id,
          message: err.message,
        });
      }
    }

    logger.info('Shipping tier detected', { orderId: order.id, shippingTier });

    // ---------------------------------------------------------------
    // Step 4: Call FreightClub Get Rates API
    // ---------------------------------------------------------------
    const destination = order.shipping_address || {};
    const pickupDate = new Date();
    pickupDate.setDate(pickupDate.getDate() + 2);

    // Calculate total declared value from all boxes
    const totalDeclaredValue = boxes.reduce((sum, b) => sum + (b.declaredValue || 0), 0);

    const ratePayload = {
      orderRef: String(order.order_number || order.name || order.id),
      pickupDate: pickupDate.toISOString().split('T')[0],
      origin: WAREHOUSE_ORIGIN,
      destination: {
        zip: destination.zip || '',
        city: destination.city || '',
        state: destination.province_code || destination.province || '',
        country: destination.country_code || 'US',
        locationType: 'Residential',
      },
      boxes,
      totalDeclaredValue,
      serviceLevel: shippingTier === 'Premier' ? 'Threshold' : 'CurbsideLiftGate',
      accessorials: ['LiftGateDropOff'],
    };

    logger.info('FreightClub rate payload', {
      orderId: order.id,


      orderRef: ratePayload.orderRef,
      origin: ratePayload.origin.zip,
      destination: ratePayload.destination.zip,
      boxes: ratePayload.boxes.length,
      serviceLevel: ratePayload.serviceLevel,
    });

    logger.info('Rate payload orderRef', { orderRef: ratePayload.orderRef });

    let ratesResult;
    try {
      ratesResult = await freightclub.getRates(ratePayload);
      logger.info('FreightClub rates received', {
        orderId: order.id,
        shipmentNumber: ratesResult?.ShipmentNumber,
      });
    } catch (err) {
      logger.warn('FreightClub getRates failed, retrying once...', {
        orderId: order.id,
        message: err.message,
      });
      try {
        ratesResult = await freightclub.getRates(ratePayload);
        logger.info('FreightClub rates received on retry', {
          orderId: order.id,
          shipmentNumber: ratesResult?.ShipmentNumber,
        });
      } catch (retryErr) {
        logger.error('FreightClub getRates failed after retry', {
          orderId: order.id,
          message: retryErr.message,
        });
        return;
      }
    }

    const shipmentNumber = ratesResult?.ShipmentNumber || 'N/A';

    // Count available quotes
    const allQuotes = (ratesResult?.CompositeRateQuote || []).flatMap(
      (group) => group.Quotes || []
    );

    // ---------------------------------------------------------------
    // Step 5: Store FreightClub reference on Shopify order
    // ---------------------------------------------------------------
    try {
      await shopify.updateOrderMetafield(
        order.id,
        'fc_shipment_number',
        String(shipmentNumber)
      );
      await shopify.updateOrderMetafield(
        order.id,
        'fc_shipping_tier',
        shippingTier
      );
    } catch (err) {
      logger.error('Failed to store FC reference on Shopify order', {
        orderId: order.id,
        message: err.message,
      });
    }

    // ---------------------------------------------------------------
    // Step 6: Send notification to Cole's team
    // ---------------------------------------------------------------
    const customerName = [
      destination.first_name,
      destination.last_name,
    ]
      .filter(Boolean)
      .join(' ') || 'N/A';

    await notification.notifyFreightOrder({
      shopifyOrderNumber: order.order_number,
      shopifyOrderName: order.name || `#${order.order_number}`,
      shipmentNumber,
      shippingTier,
      customerName,
      quoteCount: allQuotes.length,
    });

    // ---------------------------------------------------------------
    // Step 7: Register for tracking polling
    // ---------------------------------------------------------------
    if (shipmentNumber && shipmentNumber !== 'N/A') {
      trackingPoller.trackShipment(shipmentNumber, {
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
        shopifyOrderNumber: String(order.order_number),
        shippingTier,
      });
    }

    logger.info('Webhook processing complete', {
      orderId: order.id,
      shipmentNumber,
      shippingTier,
      quotes: allQuotes.length,
    });
  } catch (error) {
    logger.error('Webhook processing error', {
      message: error.message,
      stack: error.stack,
    });
    // Already responded 200 — log only
  }
});

/**
 * POST /api/webhooks/shopify-order-cancelled
 *
 * Receives Shopify's orders/cancelled webhook. If the order had a FreightClub
 * shipment:
 *   1. Attempts to cancel on FC (works only if booked — has ConfirmationNumber)
 *   2. Flags the order metafield as cancelled (so dashboard team knows)
 *   3. Removes from tracking poller
 *   4. Sends cancellation email to Cole's team — DO NOT BOOK this quote
 */
router.post('/shopify-order-cancelled', verifyShopifyHmac, async (req, res) => {
  try {
    res.status(200).json({ received: true });

    const order = req.body;
    logger.info('Received Shopify order cancellation webhook', {
      orderId: order.id,
      orderNumber: order.order_number,
      orderName: order.name,
      cancelReason: order.cancel_reason,
    });

    // Look up the FC shipment number from order metafields
    let shipmentNumber = null;
    try {
      const metafields = await shopify.getOrderMetafields(order.id);
      const fcMeta = metafields.find(
        (mf) => mf.namespace === 'custom' && mf.key === 'fc_shipment_number'
      );
      shipmentNumber = fcMeta?.value;
    } catch (err) {
      logger.error('Failed to fetch order metafields for cancellation', {
        orderId: order.id,
        message: err.message,
      });
    }

    if (!shipmentNumber || shipmentNumber === 'N/A') {
      logger.info('No FreightClub shipment on this order — nothing to cancel', {
        orderId: order.id,
      });
      return;
    }

    logger.info('FreightClub shipment found for cancelled order', {
      orderId: order.id,
      shipmentNumber,
    });

    // We do NOT attempt automatic cancellation on FreightClub because:
    // - The FC Cancel API requires a ConfirmationNumber (assigned after booking)
    // - Cole's team books shipments manually from the FC dashboard
    // - Our server never receives the ConfirmationNumber
    // Instead, we rely on the email notification below to alert the team.

    // Flag the order as cancelled in Shopify metafields
    try {
      await shopify.updateOrderMetafield(
        order.id,
        'fc_status',
        'CANCELLED — DO NOT BOOK'
      );
      logger.info('Order flagged as cancelled in Shopify metafields', {
        orderId: order.id,
      });
    } catch (err) {
      logger.error('Failed to flag order as cancelled in metafields', {
        orderId: order.id,
        message: err.message,
      });
    }

    // Remove from tracking poller
    trackingPoller.untrackShipment(String(shipmentNumber));

    // Notify the team — this is the primary safety net
    await notification.notifyFreightCancellation({
      shopifyOrderName: order.name || `#${order.order_number}`,
      shipmentNumber,
      reason: order.cancel_reason || 'Not specified',
    });

    logger.info('Cancellation processing complete', {
      orderId: order.id,
      shipmentNumber,
    });
  } catch (error) {
    logger.error('Cancellation webhook processing error', {
      message: error.message,
      stack: error.stack,
    });
  }
});

module.exports = router;
