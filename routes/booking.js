const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const freightclub = require('../services/freightclub');
const shopify = require('../services/shopify');

/**
 * POST /api/booking
 *
 * Accepts a selected rate ID and order details, books the shipment
 * with FreightClub, and writes the booking reference back to the
 * Shopify order as a metafield.
 */
router.post('/', async (req, res) => {
  try {
    const { rateId, orderId, orderDetails } = req.body;

    if (!rateId || !orderId) {
      return res.status(400).json({
        error: 'rateId and orderId are required',
      });
    }

    const booking = await freightclub.bookShipment(rateId, orderDetails);

    // Persist the FreightClub shipment ID on the Shopify order
    if (booking?.shipmentId) {
      await shopify.updateOrderMetafield(
        orderId,
        'shipment_id',
        String(booking.shipmentId)
      );
      logger.info('Stored shipment ID on Shopify order', {
        orderId,
        shipmentId: booking.shipmentId,
      });
    }

    return res.json({
      success: true,
      booking,
    });
  } catch (error) {
    logger.error('POST /api/booking error', { message: error.message });
    return res.status(500).json({ error: 'Failed to book shipment' });
  }
});

module.exports = router;
