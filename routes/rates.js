const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const freightclub = require('../services/freightclub');
const shopify = require('../services/shopify');

/**
 * POST /api/rates
 *
 * Accepts order data (line items with product/variant IDs, destination address),
 * looks up product dimensions from Shopify metafields, builds a shipment payload,
 * and returns freight rates from FreightClub.
 */
router.post('/', async (req, res) => {
  try {
    const { lineItems, destination, origin } = req.body;

    if (!lineItems?.length || !destination) {
      return res.status(400).json({
        error: 'lineItems (array) and destination (object) are required',
      });
    }

    // Build items array with dimensions pulled from variant metafields
    const items = [];
    for (const item of lineItems) {
      const metafields = await shopify.getVariantMetafields(item.variantId);

      // Map metafields into a keyed lookup for convenience
      const meta = {};
      for (const mf of metafields) {
        meta[mf.key] = mf.value;
      }

      items.push({
        sku: item.sku,
        quantity: item.quantity,
        weight: parseFloat(meta.weight) || item.weight || 0,
        length: parseFloat(meta.length) || 0,
        width: parseFloat(meta.width) || 0,
        height: parseFloat(meta.height) || 0,
        description: item.title || '',
      });
    }

    const shipmentDetails = {
      origin: origin || {
        // Turn Offroad warehouse — 1791 3rd St, Riverside, CA 92507
        zip: '92507',
        city: 'Riverside',
        state: 'CA',
        country: 'US',
        locationType: 'Commercial',
        locationName: 'Turn Offroad Warehouse',
      },
      destination: {
        zip: destination.zip,
        city: destination.city,
        state: destination.province_code || destination.state,
        country: destination.country_code || destination.country || 'US',
      },
      items,
    };

    const ratesResponse = await freightclub.getRates(shipmentDetails);

    logger.info('Rates returned to caller', { count: ratesResponse?.rates?.length ?? 0 });
    return res.json(ratesResponse);
  } catch (error) {
    logger.error('POST /api/rates error', { message: error.message });
    return res.status(500).json({ error: 'Failed to fetch rates' });
  }
});

module.exports = router;
