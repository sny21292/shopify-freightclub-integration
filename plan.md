# Turn Offroad — Shopify Order Routing System
## Shopify → FreightClub + ShipStation Integration

---

## Project Overview

Build a server-side integration that listens for new Shopify orders and intelligently routes them to the correct shipping platform — either **FreightClub** (for LTL/oversized freight items) or **ShipStation** (for smaller packages via FedEx). The system also syncs tracking numbers back to Shopify automatically.

**Client:** Turn Offroad LLC  
**Store Platform:** Shopify  
**Warehouse Address:** 1791 3rd St, Riverside, CA 92507  
**FreightClub Profile ID:** 17698  
**FreightClub API Docs:** https://api.freightclub.com/ApiDoc/index/index.html  

---

## Current Manual Workflow (What We're Replacing)

1. All orders flow from Shopify → ShipStation
2. Staff manually identifies LTL/oversized items in ShipStation
3. Staff deletes those items from ShipStation
4. Staff manually creates those shipments on FreightClub's website
5. Staff copies tracking numbers from FreightClub back to Shopify
6. Staff manually marks orders as fulfilled in Shopify

---

## Target Automated Workflow

### Order Routing Flow

1. Customer places an order on the Shopify store
2. Shopify fires a webhook to our server with the order data
3. Server inspects the order line items:
   - Checks if any products are tagged **"Freightclub"** (or equivalent LTL/oversized tag)
   - If **NO freight-eligible products** → ignore the order entirely (ShipStation handles it via its existing Shopify integration)
   - If **YES freight-eligible products** → proceed to step 4
4. Server checks which **shipping method** the customer selected at checkout (managed by the Intuitive Shipping app):
   - **"Free Freight Shipping"** (Standard) → Economy LTL carriers, 8–12 day transit
   - **"Premier Carrier Delivery"** ($250 upgrade) → FedEx Freight and Estes only, 4–7 day transit
5. Server calls the **FreightClub Get Rates API** with:
   - Product dimensions (length, width, height in inches) and weight (lbs)
   - Origin: warehouse address (1791 3rd St, Riverside, CA 92507)
   - Destination: customer's shipping address
   - The Shopify order number passed as `OrderReferenceID` (appears as "Customer PO" in FreightClub dashboard)
6. The shipment + rates appear in **FreightClub's dashboard** under "Open Quotes" (API-quoted order visibility has been enabled on the account)
7. Cole's shipping team receives a **notification** (email or Slack) with:
   - Shopify order number
   - FreightClub shipment number (OrderID)
   - Which shipping tier the customer chose (Standard vs Premier)
   - A link to the FreightClub dashboard
8. Cole's team opens FreightClub dashboard, reviews the rates, and **books manually** from there
9. After booking, the system **polls FreightClub for tracking info** and pushes it back to Shopify, marking the order as fulfilled

### Important: NO Auto-Booking
The system does NOT auto-book shipments. It only creates the shipment and fetches rates. Cole's team wants to manually review and select the carrier from the FreightClub dashboard before booking. Sometimes they prefer a better carrier over the cheapest one.

---

## ShipStation Configuration

ShipStation is already configured (via its built-in settings) to **not import items tagged "Freightclub"**. This is handled on ShipStation's side, not in our code. Our system only needs to handle the FreightClub routing — ShipStation continues to work as normal for all non-freight items.

---

## Split Orders

If a single customer order contains BOTH:
- Regular items (small packages → ShipStation/FedEx)
- Freight-eligible items (LTL/oversized → FreightClub)

Both fulfillments should happen independently on the same Shopify order. The store already has a split order application installed in Shopify to handle dividing SKUs.

---

## Product Dimensions & Weight

FreightClub's API requires dimensions (L × W × H in inches) and weight (lbs) for every item.

**Approach: Shopify Product Metafields (Option A — confirmed by client)**
- Add custom metafields to each Shopify product: `length`, `width`, `height`, `freight_category`
- The client's team fills these in for each LTL/oversized product
- Our system reads these metafields when constructing the API request

**Weight:** Already set on products in Shopify — client team needs to verify accuracy for LTL items.

**Note:** FreightClub has a "Manage Products" feature where SKU dimensions can be saved, but there is currently NO API call that references saved SKUs. So we must pass dimensions with every API call.

---

## FreightClub API Integration Details

### Authentication
- **API Token ID:** 30991 ("development") — Active and approved
- **Account email:** cole@turnoffroad.com
- **API Base:** https://api.freightclub.com

### Key API Endpoints Used

1. **Get Rates API** — Creates a shipment and returns available carrier rates
   - Pass product dimensions, weight, origin/destination addresses
   - Pass Shopify order number as `OrderReferenceID` → appears as "Customer PO" in dashboard
   - Returns a `ShipmentNumber` which equals the `OrderID` in the FreightClub Manage Orders page
   - API-quoted orders are now visible in the dashboard under "Open Quotes" (enabled by FreightClub support)

2. **Tracking API** — Retrieve tracking number after a shipment is booked
   - Refer to page 34 of the FreightClub API documentation for details
   - Page 50 has sample code
   - Tracking number is automatically created when a shipment is booked in the dashboard
   - Our system should poll this endpoint to detect when tracking becomes available

### API Confirmed Behaviors (from FreightClub team — Krystian Skruch)
- The `ShipmentNumber` returned by Get Rates is the same as `OrderID` in the dashboard
- The `OrderReferenceID` field carries through to API-created quotes and appears as "Customer PO"
- API-quoted orders are now visible in the "Open Quotes" tab under Manage Orders
- Tracking number is auto-created upon booking — poll the tracking endpoint to retrieve it

---

## Tracking Sync

- FreightClub does NOT push tracking updates automatically (no webhooks for tracking)
- Our system must **poll FreightClub periodically** (every hour or less — client wants it as frequent as possible) to check for new tracking numbers
- When a tracking number is found:
  1. Update Shopify fulfillment with the tracking number
  2. Mark the order as fulfilled in Shopify
  3. Customer automatically receives their shipping notification from Shopify

---

## Notification System

When a freight-eligible order is detected and rates are fetched, notify Cole's team with:
- Shopify order number
- FreightClub shipment/order number
- Shipping tier selected by customer (Standard Freight vs Premier Carrier)
- Link to FreightClub dashboard to review and book

Notification method: Email (or Slack — confirm with client)

---

## Checkout Shipping Tiers (Managed by Intuitive Shipping App)

The Shopify checkout uses the **Intuitive Shipping** app to present freight shipping options. These only appear when the cart contains a freight-eligible product (e.g., hard tops, bumpers).

| Tier | Display Name | Customer Cost | Carriers | Transit Time |
|------|-------------|---------------|----------|-------------|
| Standard | Free Freight Shipping | $0 (Free) | Economy LTL carriers | 8–12 days |
| Premier | Premier Carrier Delivery | $250 | FedEx Freight, Estes only | 4–7 days |

Our system reads which tier the customer chose and flags it on the notification so Cole knows which carrier pool to select from when booking.

---

## Infrastructure

- **Server:** Digital Ocean
- **Subdomain:** https://freightclub-turnoffroad.duckdns.org (handles webhooks)
- **Webhook:** Shopify order creation webhook → triggers the routing logic

---

## Technical Architecture Summary
```
Shopify Order Created
        │
        ▼
  Webhook → Our Server
        │
        ▼
  Check line items for "Freightclub" tag
        │
   ┌────┴────┐
   │         │
  NO        YES
   │         │
   ▼         ▼
 Ignore    Check shipping tier
(SS ok)    (Standard vs Premier)
              │
              ▼
        Call FreightClub Get Rates API
        (pass dims, weight, addresses,
         Shopify order # as OrderReferenceID)
              │
              ▼
        Shipment appears in FC Dashboard
        (Open Quotes tab)
              │
              ▼
        Send notification to Cole's team
        (order #, shipment #, tier, link)
              │
              ▼
        Cole reviews rates in FC Dashboard
        and books manually
              │
              ▼
        Polling job detects tracking number
        (runs every hour or more frequently)
              │
              ▼
        Update Shopify fulfillment
        + mark as fulfilled
        → Customer gets shipping notification
```

---

## Project Estimate (from original quote)

| Component | Cost |
|-----------|------|
| Shopify webhook + LTL tag detection | $150 |
| FreightClub API integration (rate + tracking) | $350 |
| Tracking sync back to Shopify + fulfillment | $150 |
| Server setup, logging & deployment | $100 |
| **Total** | **$700–$900** |

---

## Key Contacts

| Person | Role | Email |
|--------|------|-------|
| Cole McMath | Owner, Turn Offroad | cole@turnoffroad.com |
| Jason DeArmond | Operations (Number 2) | jason@wearenumber2.com |
| Justin Jackson | Branding (Action Makes Brands) | justin@actionmakesbrands.com |
| Krystian Skruch | FreightClub Account Director | krystian.s@freightclub.com |
| Jason Nosworthy | FreightClub Sales Engineering | jason.n@freightclub.com |

---

## Open Items / Notes

1. Confirm notification method preference (email vs Slack vs both)
2. Client team needs to verify product weights are accurate for all LTL items in Shopify
3. Client team needs to fill in product metafields (L × W × H) for all freight-eligible products
4. FreightClub SKU-based dimensions exist in "Manage Products" but have no API support currently — must pass dimensions with every API call
5. Polling frequency for tracking: client wants hourly or more frequent
6. The FreightClub native Shopify app was evaluated and rejected because:
   - It shows FreightClub rates at Shopify checkout (conflicts with Intuitive Shipping control)
   - No way to filter which orders go to FreightClub vs ShipStation
   - One-click import pulls ALL orders into FreightClub, causing duplicates
7. Booking is done via credit card on the FreightClub account (not API booking / not net-terms)