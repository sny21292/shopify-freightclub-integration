const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const freightclub = require('../services/freightclub');

/**
 * GET /api/tracking/:shipmentId
 *
 * Returns the current tracking status for a FreightClub shipment.
 */
router.get('/:shipmentId', async (req, res) => {
  try {
    const { shipmentId } = req.params;

    if (!shipmentId) {
      return res.status(400).json({ error: 'shipmentId is required' });
    }

    const tracking = await freightclub.getTracking(shipmentId);

    return res.json(tracking);
  } catch (error) {
    logger.error('GET /api/tracking error', {
      shipmentId: req.params.shipmentId,
      message: error.message,
    });
    return res.status(500).json({ error: 'Failed to fetch tracking' });
  }
});

module.exports = router;
