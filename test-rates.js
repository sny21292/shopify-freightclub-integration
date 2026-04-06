/**
 * Manual test: sends a rate request to FreightClub's live API and prints the
 * results.  Run with:  node test-rates.js
 *
 * After running, check the FreightClub dashboard → Manage Orders → Open Quotes
 * to see if the quote appeared.
 *
 * NOTE: FreightClub docs say "By default all quoted orders made under the API
 * are not visible in the Freight Club application until they are booked.
 * Reach out to the support team if you would like to see quoted orders as well."
 * — so you may need to ask FC support to enable quote visibility first.
 */

require('dotenv').config();
const freightclub = require('./services/freightclub');

async function main() {
  console.log('\n=== FreightClub Rate Request Test ===\n');

  // Pickup date must be a future business day
  const pickupDate = new Date();
  pickupDate.setDate(pickupDate.getDate() + 2);
  const pickupDateStr = pickupDate.toISOString().split('T')[0]; // YYYY-MM-DD

  const opts = {
    orderRef: 'TEST-001',
    pickupDate: pickupDateStr,

    // Origin — Turn Offroad warehouse: 1791 3rd St, Riverside, CA 92507
    origin: {
      zip: '92507',
      city: 'Riverside',
      state: 'CA',
      country: 'US',
      locationType: 'Commercial',
      locationName: 'Turn Offroad Warehouse',
    },

    // Destination — test residential address
    destination: {
      zip: '90210',
      city: 'Beverly Hills',
      state: 'CA',
      country: 'US',
      locationType: 'Residential',
    },

    // Simulated Bronco hard top shipment
    boxes: [
      {
        description: 'Expedition Hard Top',
        sku: 'HTJKSF-M4SH',
        qty: 1,
        weight: 150,          // lbs
        length: 60,           // inches
        width: 48,
        height: 36,
        declaredValue: 2500,
        category: 'GeneralCommodity',
      },
    ],

    totalDeclaredValue: 2500,
    serviceLevel: 'CurbsideLiftGate',
    accessorials: ['LiftGateDropOff'],
  };

  try {
    const result = await freightclub.getRates(opts);

    console.log('\n--- Top-level response ---');
    console.log('Shipment Number:', result.ShipmentNumber);
    console.log('Best Quote #:', result.Quote);
    console.log('Best Price:', result.TotalNetCharge?.Value, result.TotalNetCharge?.Unit);
    console.log('Pickup Date:', result.PickupDate);

    if (result.Warnings?.length) {
      console.log('\nWarnings:', result.Warnings);
    }

    const allQuotes = (result.CompositeRateQuote || []).flatMap(
      (group) => group.Quotes || []
    );

    if (allQuotes.length === 0) {
      console.log('\nNo quotes returned.');
    } else {
      console.log(`\n--- ${allQuotes.length} quote(s) returned ---\n`);
      allQuotes.forEach((q, i) => {
        console.log(
          `  ${i + 1}. Quote #${q.QuoteNumber}  |  ` +
          `${q.CarrierName || 'Unknown'}  |  ` +
          `$${q.NetCharge?.toFixed(2) ?? '?'}  |  ` +
          `${q.ServiceLevelDescription || q.ServiceLevel || ''}  |  ` +
          `Transit: ${q.TransitTime || q.TransitDays || '?'}`
        );
      });
    }

    console.log('\n--- Full JSON (for debugging) ---');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('\nRequest failed:');
    console.error('Status:', error.response?.status);
    console.error('Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Message:', error.message);
  }
}

main();
