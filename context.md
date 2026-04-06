# FreightClub Shopify Integration — Project Context

## Project Overview
Building a Node.js backend service to integrate **FreightClub** (LTL freight shipping provider) with **Shopify** for Turn Offroad LLC. This service handles shipping rate fetching, shipment booking, and tracking for freight-eligible products (large items like hard tops, bumpers, etc.).

This is a **separate service** running alongside the existing Shopify-Katana integration on the same Digital Ocean droplet.

---

## Client Details
- **Client:** Cole at Turn Offroad LLC
- **Store:** [turnoffroad.com](https://turnoffroad.com)
- **Shopify Admin:** [admin.shopify.com/store/turn-offroad](https://admin.shopify.com/store/turn-offroad)
- **Products:** Off-road parts for Ford Bronco & Jeep (hard tops, bumpers, sliders, etc.)
- **Existing Integration:** Shopify-Katana MRP sync (PO arrival dates → variant metafields)

---

## Server Details

### Digital Ocean Droplet (Shared with Katana Integration)
- **Name:** ubuntu-s-1vcpu-512mb-10gb-nyc3-01
- **OS:** Ubuntu (GNU/Linux)
- **Specs:** 512 MB RAM / 10 GB Disk / 1 vCPU / 1GB Swap
- **IP Address:** 159.203.85.16
- **Location:** NYC3

### Two Services Running on Same Server
| Service | Directory | Port | URL | PM2 Name |
|---------|-----------|------|-----|----------|
| Katana Integration | `~/shopify-katana-integration` | 3000 | `https://turnoffroad.duckdns.org` | shopify-katana-integration |
| FreightClub Integration | `~/freightclub-integration` | 3001 | `https://freightclub-turnoffroad.duckdns.org` | freightclub-integration |

### How Multiple Services Work
Nginx acts as a reverse proxy using virtual hosting. Both DuckDNS subdomains point to the same IP (159.203.85.16). Nginx reads the `Host` header in each request and routes to the correct port:
```
turnoffroad.duckdns.org              → Nginx → localhost:3000 (Katana)
freightclub-turnoffroad.duckdns.org  → Nginx → localhost:3001 (FreightClub)
```

### Server Access
- **SSH:** `ssh root@159.203.85.16`
- **FreightClub URL:** `https://freightclub-turnoffroad.duckdns.org`
- **Katana URL:** `https://turnoffroad.duckdns.org` (unchanged)

---

## What's Been Completed

### 1. Server Infrastructure Setup
- ✅ System packages updated (`apt update && apt upgrade`)
- ✅ Server rebooted (pending restart from screenshot resolved)
- ✅ Created new project directory: `~/freightclub-integration`
- ✅ Initialized Node.js project (`npm init`)
- ✅ Installed dependencies (express, axios, dotenv, node-cron, winston)

### 2. DuckDNS Subdomain
- ✅ Created `freightclub-turnoffroad.duckdns.org` on DuckDNS
- ✅ Pointed to same IP: `159.203.85.16`

### 3. Nginx Configuration
- ✅ Created Nginx config: `/etc/nginx/sites-available/freightclub`
- ✅ Enabled site via symlink to `/etc/nginx/sites-enabled/`
- ✅ Nginx tested (`nginx -t`) and reloaded
- ✅ Requests to `freightclub-turnoffroad.duckdns.org` route to `localhost:3001`

**Nginx Config (`/etc/nginx/sites-available/freightclub`):**
```nginx
server {
    listen 80;
    server_name freightclub-turnoffroad.duckdns.org;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```
*(Note: Certbot will have auto-modified this file to add SSL/HTTPS directives)*

### 4. SSL Certificate
- ✅ Certbot installed SSL certificate for `freightclub-turnoffroad.duckdns.org`
- ✅ HTTPS working and verified
- ✅ Auto-renewal confirmed (`certbot renew --dry-run` passed for both domains)
- ✅ Certificate path: `/etc/letsencrypt/live/freightclub-turnoffroad.duckdns.org/fullchain.pem`

### 5. Project File Structure (Created via Cursor)
- ✅ All files scaffolded with placeholder/starter code
- ✅ Uploaded to server via SFTP
- ✅ `npm install` run on server to install dependencies

```
freightclub-integration/
├── server.js                  # Express server entry point (port 3001)
├── .env                       # API keys & configuration
├── .env.example               # Template for env vars
├── .gitignore                 # node_modules, .env, logs/
├── package.json               # Node dependencies
├── package-lock.json
├── services/
│   ├── freightclub.js         # FreightClub API wrapper (getRates, bookShipment, getTracking)
│   └── shopify.js             # Shopify API wrapper (getOrder, getProduct, metafields, fulfillment)
├── routes/
│   ├── rates.js               # POST /api/rates - fetch shipping rates
│   ├── booking.js             # POST /api/booking - book a shipment
│   ├── tracking.js            # GET /api/tracking/:shipmentId - tracking status
│   └── webhooks.js            # POST /api/webhooks/shopify-order - order webhook handler
├── cron/
│   └── trackingPoller.js      # Hourly tracking poll job
├── utils/
│   └── logger.js              # Winston logger config
├── logs/                      # Auto-generated log files
└── .vscode/
    └── sftp.json              # SFTP config for VS Code deployment
```

### 6. PM2 Process Manager
- ✅ FreightClub server registered with PM2: `pm2 start server.js --name freightclub-integration`
- ✅ PM2 process list saved: `pm2 save`
- ✅ Both services showing as `online` in `pm2 status`

### 7. Health Check Verified
- ✅ `curl https://freightclub-turnoffroad.duckdns.org/health` returns success response
- ✅ Server running and accessible via HTTPS

---

## Environment Variables (.env)
```
PORT=3001
NODE_ENV=production

# FreightClub API
FREIGHTCLUB_API_URL=https://api.freightclub.com
FREIGHTCLUB_API_KEY=                    # To be filled once received from FreightClub
FREIGHTCLUB_ACCOUNT_ID=                 # To be filled once received from FreightClub

# Shopify API (same store as Katana integration)
SHOPIFY_STORE_URL=turn-offroad.myshopify.com
SHOPIFY_ACCESS_TOKEN=                   # Same token or new app — TBD
SHOPIFY_API_VERSION=2024-10

# Tracking Cron Schedule
TRACKING_POLL_INTERVAL=0 * * * *        # Every hour on the hour
```

---

## API Endpoints (Current)
| Endpoint | Method | Description | Status |
|----------|--------|-------------|--------|
| `/health` | GET | Health check — status, uptime, timestamp | ✅ Working |
| `/status` | GET | Last operation info | ✅ Scaffolded |
| `/api/rates` | POST | Fetch FreightClub shipping rates for an order | ✅ Scaffolded (placeholder) |
| `/api/booking` | POST | Book a shipment with selected rate | ✅ Scaffolded (placeholder) |
| `/api/tracking/:shipmentId` | GET | Get tracking status for a shipment | ✅ Scaffolded (placeholder) |
| `/api/webhooks/shopify-order` | POST | Receive Shopify order webhook | ✅ Scaffolded (placeholder) |

---

## Installed NPM Packages
| Package | Purpose |
|---------|---------|
| express | Web server framework |
| axios | HTTP client for API calls |
| dotenv | Load environment variables from .env |
| node-cron | Schedule hourly tracking polls |
| winston | Production logging (console + file) |
| nodemon | Auto-restart during development (dev dependency) |

---

## Deployment Workflow
```
1. Edit code locally in VS Code / Cursor
2. Upload to server via SFTP (configured in .vscode/sftp.json)
3. SSH into server: ssh root@159.203.85.16
4. cd ~/freightclub-integration
5. npm install                              (if new dependencies added)
6. pm2 restart freightclub-integration
7. pm2 logs freightclub-integration --lines 20   (verify startup)
8. curl https://freightclub-turnoffroad.duckdns.org/health   (verify response)
```

---

## Useful Commands
| Task | Command |
|------|---------|
| SSH into server | `ssh root@159.203.85.16` |
| Go to project | `cd ~/freightclub-integration` |
| PM2 status (both apps) | `pm2 status` |
| PM2 start | `pm2 start server.js --name freightclub-integration` |
| PM2 restart | `pm2 restart freightclub-integration` |
| PM2 stop | `pm2 stop freightclub-integration` |
| PM2 logs | `pm2 logs freightclub-integration` |
| PM2 logs (last 50 lines) | `pm2 logs freightclub-integration --lines 50` |
| Install dependencies | `npm install` |
| Test health endpoint | `curl https://freightclub-turnoffroad.duckdns.org/health` |
| Check Nginx config | `sudo nginx -t` |
| Reload Nginx | `sudo systemctl reload nginx` |
| Check SSL certs | `sudo certbot certificates` |
| Renew SSL (dry run) | `sudo certbot renew --dry-run` |
| Check memory | `free -m` |
| Check disk | `df -h` |

---

## Open Scoping Questions for Cole (BEFORE Building Integration Logic)

These questions need answers before writing the actual FreightClub API integration code. The scaffolding is ready — once these are answered, the placeholder functions get filled in.

### 1. Two-Tier Shipping at Checkout
Cole mentioned wanting two options for customers: Free shipping (standard carrier via ShipStation) and Premier Carrier (FreightClub, at a cost to customer). How should this appear at Shopify checkout? Does the existing split order app handle the routing, or does checkout need customization?

### 2. Rate Approval Workflow
Cole wants to manually review/select FreightClub rates before booking. What does this look like? Options:
- Email notification with rates for Cole to review?
- Simple admin dashboard/page?
- Slack notification?
- Something else?

### 3. FreightClub Native SKU Dimension Matching
FreightClub may support native SKU-to-dimension mapping within their system. If so, we may NOT need to store product dimensions in Shopify metafields at all — FreightClub would already know the dimensions per SKU. This could simplify the build significantly.

### 4. Product Weights in Shopify
Are the current product weights in Shopify accurate enough for LTL freight quoting? FreightClub needs weight + dimensions for rate calculation. If weights are incorrect, rates will be wrong.

### 5. Impact on Estimate
The final time/cost estimate depends on the answers above. Simpler workflow = fewer hours. Dashboard = more hours.

---

## What's Next
1. **Send Cole a scoping email** covering the open questions above
2. **Get FreightClub API credentials** (API key, account ID, API documentation)
3. **Review FreightClub API docs** to understand endpoints, auth, request/response formats
4. **Fill in placeholder functions** once scoping is finalized
5. **Set up Shopify app permissions** — may need additional scopes (read_orders, write_orders, read_fulfillments, write_fulfillments) depending on the workflow
6. **Configure GitHub repo** with deploy key for version control

---

## Key Differences from Katana Integration
| Aspect | Katana Integration | FreightClub Integration |
|--------|-------------------|------------------------|
| Purpose | Sync PO arrival dates to metafields | Shipping rates, booking, tracking |
| Direction | Katana → Shopify (one-way sync) | Shopify ↔ FreightClub (two-way) |
| Trigger | Webhooks + cron | Order creation + manual approval |
| Port | 3000 | 3001 |
| URL | turnoffroad.duckdns.org | freightclub-turnoffroad.duckdns.org |
| Complexity | Moderate (data sync) | Higher (multi-step workflow) |

---

## Developer Info
- **Developer:** Sunil Sharma
- **Experience:** 7 years (HTML, JS, PHP, WordPress, Laravel, Shopify)
- **Learning:** React, Next.js, Node.js
- **Tools:** VS Code, Cursor CLI, SFTP deployment, PM2, Digital Ocean

---

*Last updated: March 6, 2026*