const { Resend } = require('resend');
const logger = require('../utils/logger');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFY_EMAIL_TO = process.env.NOTIFY_EMAIL_TO || '';
const NOTIFY_EMAIL_CC = process.env.NOTIFY_EMAIL_CC || '';
const NOTIFY_EMAIL_FROM = process.env.NOTIFY_EMAIL_FROM || 'onboarding@resend.dev';

let resend = null;

function getResend() {
  if (!resend && RESEND_API_KEY) {
    resend = new Resend(RESEND_API_KEY);
  }
  return resend;
}

/**
 * Send a notification when a freight-eligible order is detected and rates fetched.
 *
 * @param {Object} params
 * @param {string} params.shopifyOrderNumber - e.g. "#1042"
 * @param {string} params.shopifyOrderName   - e.g. "#1042"
 * @param {string} params.shipmentNumber     - FreightClub ShipmentNumber (OrderID in dashboard)
 * @param {string} params.shippingTier       - "Standard" or "Premier"
 * @param {string} params.customerName       - Customer name from order
 * @param {number} params.quoteCount         - Number of carrier quotes returned
 */
async function notifyFreightOrder(params) {
  const {
    shopifyOrderNumber,
    shopifyOrderName,
    shipmentNumber,
    shippingTier,
    customerName,
    quoteCount,
  } = params;

  const tierLabels = {
    Premier: 'Premier Carrier Delivery ($250 upgrade) — FedEx Freight / Estes only, 4-7 days',
    Standard: 'Free Freight Shipping (Standard) — Economy LTL carriers, 8-12 days',
    Unknown: 'Unknown — shipping tier could not be detected from order',
  };
  const tierLabel = tierLabels[shippingTier] || tierLabels.Unknown;

  const dashboardUrl = 'https://app.freightclub.com';

  const subject = `Freight Order ${shopifyOrderName} — ${shippingTier} Tier — Action Required`;

  const text = [
    `New freight-eligible order requires carrier selection.`,
    ``,
    `Shopify Order: ${shopifyOrderName}`,
    `Customer: ${customerName}`,
    `FreightClub Shipment #: ${shipmentNumber}`,
    `Shipping Tier: ${tierLabel}`,
    `Carrier Quotes Available: ${quoteCount}`,
    ``,
    `Review rates and book the shipment:`,
    `${dashboardUrl}`,
    ``,
    `Go to Manage Orders → Open Quotes to find this shipment.`,
  ].join('\n');

  const html = `
    <h2>New Freight Order — Action Required</h2>
    <table style="border-collapse:collapse;font-family:sans-serif;">
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Shopify Order</td><td>${shopifyOrderName}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Customer</td><td>${customerName}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">FreightClub Shipment #</td><td>${shipmentNumber}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Shipping Tier</td><td>${tierLabel}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Carrier Quotes</td><td>${quoteCount}</td></tr>
    </table>
    <br/>
    <p><a href="${dashboardUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;">Open FreightClub Dashboard</a></p>
    <p style="color:#666;font-size:13px;">Go to Manage Orders → Open Quotes to find this shipment.</p>
  `;

  // Always log the notification details
  logger.info('Freight order notification', {
    shopifyOrder: shopifyOrderName,
    shipmentNumber,
    shippingTier,
    customerName,
    quoteCount,
  });

  // Send email via Resend
  const client = getResend();
  if (client && NOTIFY_EMAIL_TO) {
    try {
      const emailPayload = {
        from: NOTIFY_EMAIL_FROM,
        to: NOTIFY_EMAIL_TO,
        subject,
        text,
        html,
      };
      if (NOTIFY_EMAIL_CC) emailPayload.cc = NOTIFY_EMAIL_CC;

      const { data, error } = await client.emails.send(emailPayload);

      if (error) {
        logger.error('Failed to send notification email via Resend', {
          error: error.message,
        });
      } else {
        logger.info('Notification email sent via Resend', {
          to: NOTIFY_EMAIL_TO,
          id: data.id,
        });
      }
    } catch (error) {
      logger.error('Failed to send notification email', {
        message: error.message,
      });
    }
  } else {
    logger.warn('Email notification skipped — Resend API key not configured');
  }
}

/**
 * Send a notification when a freight order is cancelled.
 *
 * @param {Object} params
 * @param {string} params.shopifyOrderName   - e.g. "#SH11120"
 * @param {string} params.shipmentNumber     - FreightClub ShipmentNumber
 * @param {string} params.reason             - Cancellation reason from Shopify
 */
async function notifyFreightCancellation(params) {
  const {
    shopifyOrderName,
    shipmentNumber,
    reason,
    fcCancelled,
  } = params;

  const subject = `Freight Order ${shopifyOrderName} — CANCELLED`;

  const text = [
    `A freight-eligible order has been cancelled on Shopify.`,
    ``,
    `Shopify Order: ${shopifyOrderName}`,
    `FreightClub Shipment #: ${shipmentNumber}`,
    `Cancellation Reason: ${reason || 'Not specified'}`,
    ``,
    `ACTION REQUIRED:`,
    `- If the quote has NOT been booked yet — disregard it in the Open Quotes tab.`,
    `- If the shipment has already been booked — please cancel it manually from the FreightClub dashboard.`,
  ].join('\n');

  const html = `
    <h2 style="color:#dc2626;">Freight Order Cancelled</h2>
    <table style="border-collapse:collapse;font-family:sans-serif;">
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Shopify Order</td><td>${shopifyOrderName}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">FreightClub Shipment #</td><td>${shipmentNumber}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Reason</td><td>${reason || 'Not specified'}</td></tr>
    </table>
    <br/>
    <div style="background:#fef2f2;border:1px solid #dc2626;border-radius:8px;padding:16px;font-family:sans-serif;">
      <p style="font-weight:bold;margin:0 0 8px 0;">ACTION REQUIRED:</p>
      <ul style="margin:0;padding-left:20px;">
        <li>If the quote has <strong>NOT been booked yet</strong> — disregard it in the Open Quotes tab.</li>
        <li>If the shipment has <strong>already been booked</strong> — please cancel it manually from the FreightClub dashboard.</li>
      </ul>
    </div>
    <br/>
    <p><a href="https://app.freightclub.com" style="background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;display:inline-block;">Open FreightClub Dashboard</a></p>
  `;

  logger.info('Freight order cancellation notification', {
    shopifyOrder: shopifyOrderName,
    shipmentNumber,
    reason,
    fcCancelled,
  });

  const client = getResend();
  if (client && NOTIFY_EMAIL_TO) {
    try {
      const emailPayload = {
        from: NOTIFY_EMAIL_FROM,
        to: NOTIFY_EMAIL_TO,
        subject,
        text,
        html,
      };
      if (NOTIFY_EMAIL_CC) emailPayload.cc = NOTIFY_EMAIL_CC;

      const { data, error } = await client.emails.send(emailPayload);

      if (error) {
        logger.error('Failed to send cancellation email via Resend', {
          error: error.message,
        });
      } else {
        logger.info('Cancellation email sent via Resend', {
          to: NOTIFY_EMAIL_TO,
          id: data.id,
        });
      }
    } catch (error) {
      logger.error('Failed to send cancellation email', {
        message: error.message,
      });
    }
  } else {
    logger.warn('Cancellation email skipped — Resend API key not configured');
  }
}

module.exports = { notifyFreightOrder, notifyFreightCancellation };
