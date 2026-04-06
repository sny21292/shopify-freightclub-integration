require('dotenv').config();
const axios = require('axios');

const API_URL = process.env.FREIGHTCLUB_API_URL;
const API_KEY = process.env.FREIGHTCLUB_API_KEY;

const client = axios.create({
  baseURL: API_URL,
  timeout: 90000,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  },
});

async function testCall(label, params) {
  console.log(`\n--- ${label} ---`);
  console.log('Params:', params);
  try {
    const res = await client.get('/api/tracking/ShipmentTracking', { params });
    console.log('Response:', JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.log('Error status:', err.response?.status);
    console.log('Error data:', JSON.stringify(err.response?.data, null, 2));
  }
}

async function main() {
  await testCall('customerNumber: 6885652005042', { customerNumber: '6885652005042' });
}

main();
