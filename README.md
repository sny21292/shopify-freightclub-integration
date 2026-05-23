# Shopify ↔ FreightClub Integration

Node.js service that routes Oversize Ground freight orders from Shopify to FreightClub for **Turn Offroad LLC** — quotes shipping rates, notifies the team, polls tracking, and auto-fulfills orders once a carrier tracking number is detected.

LTL freight is handled by a separate carrier outside this service (as of 2026-03-29). This service only processes items tagged **"Oversize Ground"**.

- **Production URL:** https://freightclub.turnoffroad.com (legacy: https://freightclub-turnoffroad.duckdns.org)
- **Port:** 3001
- **Runtime:** Node.js (CommonJS), Express, PM2
- **State:** JSON file at `data/active-shipments.json` (no database)

---

## How It Works

### Order Flow
1. Shopify fires an order webhook → HMAC-SHA256 verified (raw body captured by middleware).
2. Filters line items by the **"Oversize Ground"** product tag. If none match, the order is ignored.
3. Reads product dimensions (length / width / height) from variant metafields. Falls back to a Shopify API re-fetch if a tier comes back Unknown.
4. Detects the shipping tier from `shipping_lines` name:
   - `Free Freight Shipping` → **Standard**
   - `Premier Carrier Delivery` → **Premier**
5. Calls FreightClub `GetRates` (90 s timeout, 1 retry) and writes `fc_shipment_number` to the Shopify order metafield.
6. Sends a notification email to the team via Resend.
7. Registers the shipment for hourly tracking polling.
8. Cole''s team books the shipment manually from the FreightClub dashboard. **No auto-booking.**
9. The tracking poller picks up the carrier tracking number and fulfills the order on Shopify. Shopify then sends the customer the standard Shipping / Out for Delivery / Delivered emails.

### Cancellation Flow
Order/refund webhook → flags the order metafield as cancelled → removes the shipment from the active list → notifies the team. **No auto-cancel on FreightClub** (manual booking model).

### Tracking Poller (`cron/trackingPoller.js`)
Runs hourly. For each active shipment:
- Queries FreightClub by **`customerNumber`** (Shopify `order_number`), not `shipmentId`, because FC creates a new shipment ID when the team books from Open Quotes.
- Filters events by date to exclude stale events from other FC customers — FC''s `customerNumber` is not account-scoped.
- Picks the latest `ShipmentNumber` from remaining events.
- One-time on tracking-number detection: writes `fc_tracking_number`, `fc_carrier`, `fc_tracking_url` to the Shopify order; updates `fc_shipment_number` if the booked ID differs from the quote ID.
- Every cycle: refreshes `fc_status` with the latest FC tracking description.
- Skips auto-fulfillment if the order is already manually fulfilled in Shopify.
- Carrier names must match Shopify''s expected list (`UPS`, `FedEx`, `Estes`) for fulfillment to succeed.
- Removes the shipment from the active list on delivery.
- Stale shipments (30+ days) are cleaned up automatically.
- State persists in `data/active-shipments.json` (gitignored) with `trackingSaved` and `fulfilled` flags.

---

## Project Structure

```
freightclub-integration/
├── server.js                   Express entry point (port 3001)
├── routes/
│   ├── webhooks.js             Shopify order + cancellation webhook handlers
│   ├── rates.js                POST /api/rates
│   ├── booking.js              POST /api/booking
│   └── tracking.js             GET  /api/tracking/:shipmentId
├── services/
│   ├── freightclub.js          FC API client (camelCase ↔ PascalCase transform)
│   ├── shopify.js              Order / product / metafield / fulfillment ops
│   └── notification.js         Resend email delivery
├── cron/
│   └── trackingPoller.js       Hourly tracking poller
├── utils/
│   └── logger.js               Winston (console + rotating file)
├── data/
│   └── active-shipments.json   Persistent poller state (gitignored)
├── logs/                       Winston rotation output
├── test-rates.js               Manual: hits live FC GetRates API
├── test-tracking.js            Manual: hits live FC tracking API
└── .env                        Secrets (gitignored)
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Liveness check — status, uptime, timestamp |
| `/status` | GET | Last operation info |
| `/api/rates` | POST | Fetch FreightClub shipping rates for an order |
| `/api/booking` | POST | Book a shipment with a selected rate |
| `/api/tracking/:shipmentId` | GET | Get tracking status for a shipment |
| `/api/webhooks/shopify-order` | POST | Receive a Shopify order webhook (HMAC-verified) |

---

## Environment Variables

`.env` is gitignored and lives on the server only. Use `.env.example` as the template.

```
PORT=3001
NODE_ENV=production

# FreightClub API
FREIGHTCLUB_API_URL=https://api.freightclub.com
FREIGHTCLUB_API_KEY=
FREIGHTCLUB_ACCOUNT_ID=

# Shopify (turn-offroad.myshopify.com)
SHOPIFY_STORE_URL=turn-offroad.myshopify.com
SHOPIFY_ACCESS_TOKEN=
SHOPIFY_API_VERSION=2024-10

# Resend
RESEND_API_KEY=

# Cron
TRACKING_POLL_INTERVAL=0 * * * *
```

---

## Local Development

```bash
npm install
npm run dev                              # nodemon
npm start                                # plain node
node test-rates.js                       # hits live FC API
node test-tracking.js <shipmentNumber>   # hits live FC API
```

No test framework, linter, or build step.

---

## Deployment

**The production server is the source of truth.** Code changes are made on the server first, committed and pushed from there, then pulled locally.

```bash
# On the droplet (159.203.85.16)
ssh -i ~/.ssh/gretrix root@159.203.85.16   # key-only, password auth disabled
cd /root/freightclub-integration
# ... make changes ...
git add -A && git commit -m "description"
git push origin main
pm2 restart freightclub-integration
pm2 logs freightclub-integration --lines 50

# Sync local afterwards
cd shopify-frigtclube-integration && git pull origin main
```

The droplet (`159.203.85.16`, 1 vCPU / 512 MB / 10 GB, NYC3) is shared with three other services — Katana (3000), Inventory Feed (3002), QR (3003). Nginx routes by `Host` header to the right port. Both `freightclub.turnoffroad.com` and `freightclub-turnoffroad.duckdns.org` point here in parallel during the subdomain cutover, each with its own Let''s Encrypt cert.

---

## Conventions

- **CommonJS** (`require` / `module.exports`)
- **Shopify Admin API:** `2024-10`
- **Webhook verification:** HMAC-SHA256 with `crypto.timingSafeEqual()`
- **FreightClub payloads:** PascalCase on the wire, camelCase internally — the service layer transforms.
- **Rate limiting:** none on FreightClub side; Shopify writes are kept conservative.
- **State:** `data/active-shipments.json` only. No database.
- **Logs:** Winston rotation in `logs/`; PM2 captures stdout/stderr as well.

---

## Operational Reference

| Task | Command |
|------|---------|
| Health check (public) | `curl https://freightclub.turnoffroad.com/health` |
| PM2 status | `pm2 status` |
| PM2 restart | `pm2 restart freightclub-integration` |
| PM2 logs (last 50) | `pm2 logs freightclub-integration --lines 50` |
| Nginx config test | `sudo nginx -t` |
| Nginx reload | `sudo systemctl reload nginx` |
| List SSL certs | `sudo certbot certificates` |
| SSL renew dry run | `sudo certbot renew --dry-run` |
| Memory | `free -m` |
| Disk | `df -h` |
