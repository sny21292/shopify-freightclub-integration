const axios = require('axios');
const logger = require('../utils/logger');

const STORE_URL = process.env.SHOPIFY_STORE_URL;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

/**
 * Configured axios instance for Shopify REST Admin API calls.
 */
const client = axios.create({
  baseURL: `https://${STORE_URL}/admin/api/${API_VERSION}`,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': ACCESS_TOKEN,
  },
});

/**
 * Fetch a single order by ID.
 *
 * @param {string|number} orderId
 * @returns {Object} Shopify order object
 */
async function getOrder(orderId) {
  try {
    logger.info('Fetching Shopify order', { orderId });
    const { data } = await client.get(`/orders/${orderId}.json`);
    return data.order;
  } catch (error) {
    logger.error('Shopify getOrder failed', {
      orderId,
      message: error.message,
      status: error.response?.status,
    });
    throw error;
  }
}

/**
 * Fetch a product with its metafields (dimensions, freight-eligibility, etc.).
 *
 * @param {string|number} productId
 * @returns {Object} Shopify product object
 */
async function getProduct(productId) {
  try {
    logger.info('Fetching Shopify product', { productId });
    const { data } = await client.get(`/products/${productId}.json`);
    return data.product;
  } catch (error) {
    logger.error('Shopify getProduct failed', {
      productId,
      message: error.message,
      status: error.response?.status,
    });
    throw error;
  }
}

/**
 * Retrieve metafields for a specific variant (used to pull dimensions & weight).
 *
 * @param {string|number} variantId
 * @returns {Array} Array of metafield objects
 */
async function getVariantMetafields(variantId) {
  try {
    logger.info('Fetching variant metafields', { variantId });
    const { data } = await client.get(`/variants/${variantId}/metafields.json`);
    return data.metafields;
  } catch (error) {
    logger.error('Shopify getVariantMetafields failed', {
      variantId,
      message: error.message,
      status: error.response?.status,
    });
    throw error;
  }
}

/**
 * Write a metafield value on an order (e.g. tracking number, carrier, shipment ID).
 *
 * @param {string|number} orderId
 * @param {string} key - Metafield key (under a shared namespace)
 * @param {string} value - Value to store
 * @returns {Object} Created/updated metafield
 */
async function updateOrderMetafield(orderId, key, value) {
  try {
    logger.info('Updating order metafield', { orderId, key });
    const { data } = await client.post(`/orders/${orderId}/metafields.json`, {
      metafield: {
        namespace: 'custom',
        key,
        value,
        type: 'single_line_text_field',
      },
    });
    return data.metafield;
  } catch (error) {
    logger.error('Shopify updateOrderMetafield failed', {
      orderId,
      key,
      message: error.message,
      status: error.response?.status,
    });
    throw error;
  }
}

/**
 * Mark an order as fulfilled and attach tracking information.
 *
 * @param {string|number} orderId
 * @param {Object} trackingInfo - { tracking_number, tracking_url, tracking_company }
 * @returns {Object} Shopify fulfillment object
 */
async function fulfillOrder(orderId, trackingInfo) {
  try {
    logger.info('Fulfilling Shopify order', { orderId });

    // Step 1: Retrieve fulfillment orders for this order
    const { data: foData } = await client.get(
      `/orders/${orderId}/fulfillment_orders.json`
    );
    const fulfillmentOrder = foData.fulfillment_orders?.find(
      (fo) => fo.status === 'open'
    );

    if (!fulfillmentOrder) {
      throw new Error(`No open fulfillment order found for order ${orderId}`);
    }

    // Step 2: Create fulfillment with tracking
    const { data } = await client.post('/fulfillments.json', {
      fulfillment: {
        line_items_by_fulfillment_order: [
          {
            fulfillment_order_id: fulfillmentOrder.id,
          },
        ],
        tracking_info: {
          number: trackingInfo.tracking_number,
          url: trackingInfo.tracking_url,
          company: trackingInfo.tracking_company,
        },
        notify_customer: true,
      },
    });

    logger.info('Order fulfilled successfully', {
      orderId,
      fulfillmentId: data.fulfillment?.id,
    });
    return data.fulfillment;
  } catch (error) {
    logger.error('Shopify fulfillOrder failed', {
      orderId,
      message: error.message,
      status: error.response?.status,
    });
    throw error;
  }
}


/**
 * Retrieve metafields for a specific order.
 *
 * @param {string|number} orderId
 * @returns {Array} Array of metafield objects
 */
async function getOrderMetafields(orderId) {
  try {
    logger.info('Fetching order metafields', { orderId });
    const { data } = await client.get(`/orders/${orderId}/metafields.json`);
    return data.metafields;
  } catch (error) {
    logger.error('Shopify getOrderMetafields failed', {
      orderId,
      message: error.message,
      status: error.response?.status,
    });
    throw error;
  }
}

module.exports = {
  getOrder,
  getProduct,
  getVariantMetafields,
  updateOrderMetafield,
  fulfillOrder,
  getOrderMetafields,
};
