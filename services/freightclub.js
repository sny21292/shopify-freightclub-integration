const axios = require('axios');
const logger = require('../utils/logger');

const API_URL = process.env.FREIGHTCLUB_API_URL;
const API_KEY = process.env.FREIGHTCLUB_API_KEY;


/**
 * Configured axios instance for all FreightClub API calls.
 * Auth headers are attached automatically.
 */
const client = axios.create({
  baseURL: API_URL,
  timeout: 90000,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  },
});

/**
 * Fetch shipping rates from FreightClub for a given shipment.
 *
 * @param {Object} shipmentDetails - origin, destination, items with dimensions/weight
 * @returns {Object} rates response from FreightClub
 */
async function getRates(shipmentDetails) {
  try {
    logger.info('Requesting rates from FreightClub', {
      origin: shipmentDetails.origin?.zip,
      destination: shipmentDetails.destination?.zip,
    });

    // Transform to match FreightClub API schema (PascalCase)
    const origin = shipmentDetails.origin;
    const dest = shipmentDetails.destination;

    const Boxes = (shipmentDetails.boxes || []).map((box) => ({
      Description: box.description,
      SKU: box.sku,
      Quantity: box.qty,
      Weight: { Value: box.weight, Unit: 'LB' },
      Dimension: {
        Length: box.length,
        Width: box.width,
        Height: box.height,
        Unit: 'Inch',
      },
      DeclaredValue: { Value: box.declaredValue, Unit: 'USD' },
      Category: box.category,
    }));

    const payload = {
      OrderReferenceID: shipmentDetails.orderRef,
      PickupDate: shipmentDetails.pickupDate,
      PickupLocation: {
        ZipCode: origin.zip,
        City: origin.city,
        ProvinceState: origin.state,
        Country: origin.country,
        LocationType: origin.locationType,
        LocationName: origin.locationName,
      },
      DropOffLocation: {
        ZipCode: dest.zip,
        City: dest.city,
        ProvinceState: dest.state,
        Country: dest.country,
        LocationType: dest.locationType,
        LocationName: dest.locationName,
      },
      Boxes,
      TotalDeclaredValue: { Value: shipmentDetails.totalDeclaredValue, Unit: 'USD' },
      ServiceLevel: shipmentDetails.serviceLevel,
      Accessorials: shipmentDetails.accessorials,
    };

    const response = await client.post('/Rate/GetRates', payload);

    logger.info(`Received ${response.data?.rates?.length ?? 0} rate(s) from FreightClub`);
    return response.data;
  } catch (error) {
    logger.error('FreightClub getRates failed', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    throw error;
  }
}

/**
 * Book a shipment with a previously-quoted rate.
 *
 * @param {string} rateId - The selected rate ID from a prior getRates call
 * @param {Object} orderDetails - Order and contact info needed for booking
 * @returns {Object} booking confirmation from FreightClub
 */
async function bookShipment(rateId, orderDetails) {
  try {
    logger.info('Booking shipment with FreightClub', { rateId });

    const response = await client.post('/Book/BookShipment', {
      rateId,
      ...orderDetails,
    });

    logger.info('Shipment booked successfully', {
      shipmentId: response.data?.shipmentId,
    });
    return response.data;
  } catch (error) {
    logger.error('FreightClub bookShipment failed', {
      rateId,
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    throw error;
  }
}

/**
 * Get tracking status for a booked shipment.
 *
 * @param {string} shipmentId - FreightClub shipment identifier
 * @returns {Object} tracking info (status, events, ETA, etc.)
 */
async function getTracking(shipmentId, { customerNumber } = {}) {
  try {
    logger.info('Fetching tracking from FreightClub', { shipmentId, customerNumber });

    // Endpoint: GET /api/tracking/ShipmentTracking
    // Params: trackingNo, wayBillNumber, customerNumber, shipmentId
    // API uses the first non-null value.
    // We prefer customerNumber (Shopify order number) because the quote shipmentId
    // differs from the booked shipmentId when ops books via the FC dashboard.
    const params = customerNumber
      ? { customerNumber }
      : { shipmentId: parseInt(shipmentId, 10) };

    const response = await client.get('/api/tracking/ShipmentTracking', { params });

    logger.info('Tracking retrieved', {
      shipmentId,
      customerNumber,
      status: response.data?.status,
    });
    return response.data;
  } catch (error) {
    logger.error('FreightClub getTracking failed', {
      shipmentId,
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    throw error;
  }
}

/**
 * Cancel a shipment on FreightClub.
 *
 * @param {string} shipmentNumber - FreightClub shipment number
 * @returns {Object} cancellation response
 */
async function cancelShipment(shipmentNumber) {
  try {
    logger.info('Cancelling shipment on FreightClub', { shipmentNumber });

    const response = await client.get(`/Cancel/cancelShipment/${shipmentNumber}`);

    logger.info('Shipment cancelled on FreightClub', {
      shipmentNumber,
      data: response.data,
    });
    return response.data;
  } catch (error) {
    logger.error('FreightClub cancelShipment failed', {
      shipmentNumber,
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    throw error;
  }
}

module.exports = {
  getRates,
  bookShipment,
  getTracking,
  cancelShipment,
};
