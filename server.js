require('dotenv').config();

const express = require('express');
const logger = require('./utils/logger');
const trackingPoller = require('./cron/trackingPoller');

const ratesRouter = require('./routes/rates');
const bookingRouter = require('./routes/booking');
const trackingRouter = require('./routes/tracking');
const webhooksRouter = require('./routes/webhooks');

const app = express();
const PORT = process.env.PORT || 3001;

// Track when the server started and last operation for the /status endpoint
const serverState = {
  startedAt: new Date().toISOString(),
  lastOperation: null,
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Webhook routes need the raw body (Buffer) for Shopify HMAC verification.
// All other routes get standard JSON parsing.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhooks/')) {
    express.json({
      verify: (req, _res, buf) => { req.rawBody = buf; },
    })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// Log every incoming request
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl}`);
  next();
});

// ---------------------------------------------------------------------------
// App dashboard (rendered inside Shopify admin iframe)
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  const uptimeSeconds = Math.floor(process.uptime());
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeStr = days > 0
    ? `${days}d ${hours}h ${minutes}m`
    : hours > 0
      ? `${hours}h ${minutes}m`
      : `${minutes}m`;

  const notifyEmail = process.env.NOTIFY_EMAIL_TO || 'Not configured';
  const pollInterval = process.env.TRACKING_POLL_INTERVAL || '0 * * * *';
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FreightClub Integration</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap');

  *{margin:0;padding:0;box-sizing:border-box}

  :root{
    --bg:#f6f6f1;
    --card:#ffffff;
    --border:#e2e0d8;
    --text:#1a1a18;
    --text-secondary:#6b6960;
    --accent:#2a6b4a;
    --accent-light:#e8f3ed;
    --accent-warm:#c97d3c;
    --accent-warm-light:#fef6ee;
    --mono:#5c6b5e;
    --shadow:0 1px 3px rgba(26,26,24,.06),0 1px 2px rgba(26,26,24,.04);
    --shadow-lg:0 4px 12px rgba(26,26,24,.08),0 1px 3px rgba(26,26,24,.06);
    --radius:10px;
  }

  body{
    font-family:'DM Sans',system-ui,-apple-system,sans-serif;
    background:var(--bg);
    color:var(--text);
    line-height:1.55;
    -webkit-font-smoothing:antialiased;
    padding:0;
    min-height:100vh;
  }

  .shell{
    max-width:840px;
    margin:0 auto;
    padding:32px 24px 48px;
  }

  /* ── header ── */
  .header{
    display:flex;
    align-items:center;
    gap:14px;
    margin-bottom:32px;
    padding-bottom:24px;
    border-bottom:1px solid var(--border);
  }
  .header-icon{
    width:42px;height:42px;
    background:var(--accent);
    border-radius:10px;
    display:flex;align-items:center;justify-content:center;
    flex-shrink:0;
  }
  .header-icon svg{width:22px;height:22px;fill:none;stroke:#fff;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
  .header h1{font-size:20px;font-weight:700;letter-spacing:-.3px;color:var(--text)}
  .header p{font-size:13px;color:var(--text-secondary);margin-top:2px}

  /* ── cards ── */
  .card{
    background:var(--card);
    border:1px solid var(--border);
    border-radius:var(--radius);
    box-shadow:var(--shadow);
    padding:24px;
    margin-bottom:16px;
  }
  .card-label{
    font-size:11px;
    font-weight:600;
    text-transform:uppercase;
    letter-spacing:.8px;
    color:var(--text-secondary);
    margin-bottom:16px;
    display:flex;align-items:center;gap:6px;
  }
  .card-label svg{width:14px;height:14px;stroke:var(--text-secondary);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

  /* ── status ── */
  .status-row{
    display:flex;
    align-items:center;
    gap:24px;
    flex-wrap:wrap;
  }
  .status-item{display:flex;flex-direction:column;gap:4px}
  .status-item .label{font-size:12px;color:var(--text-secondary);font-weight:500}
  .status-item .value{font-family:'DM Mono',monospace;font-size:14px;font-weight:500;color:var(--text)}
  .status-dot{
    display:inline-flex;align-items:center;gap:7px;
    font-family:'DM Mono',monospace;font-size:14px;font-weight:500;
    color:var(--accent);
  }
  .status-dot::before{
    content:'';display:inline-block;
    width:8px;height:8px;
    background:var(--accent);
    border-radius:50%;
    box-shadow:0 0 0 3px var(--accent-light);
    animation:pulse 2.5s ease-in-out infinite;
  }
  @keyframes pulse{
    0%,100%{box-shadow:0 0 0 3px var(--accent-light)}
    50%{box-shadow:0 0 0 6px rgba(42,107,74,.08)}
  }

  .divider{
    width:100%;height:1px;
    background:var(--border);
    margin:20px 0;
  }

  /* ── steps ── */
  .steps{display:flex;flex-direction:column;gap:0}
  .step{
    display:flex;
    align-items:flex-start;
    gap:16px;
    padding:14px 0;
    position:relative;
  }
  .step+.step{border-top:1px dashed var(--border)}
  .step-num{
    width:28px;height:28px;
    border-radius:50%;
    background:var(--accent-light);
    color:var(--accent);
    font-family:'DM Mono',monospace;
    font-size:12px;font-weight:600;
    display:flex;align-items:center;justify-content:center;
    flex-shrink:0;
    margin-top:1px;
  }
  .step-content h3{font-size:14px;font-weight:600;margin-bottom:3px;color:var(--text)}
  .step-content p{font-size:13px;color:var(--text-secondary);line-height:1.5}

  /* ── config grid ── */
  .config-grid{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:0;
  }
  .config-item{
    padding:14px 0;
    border-bottom:1px solid var(--border);
  }
  .config-item:nth-child(odd){padding-right:20px;border-right:1px solid var(--border)}
  .config-item:nth-child(even){padding-left:20px}
  .config-item:nth-last-child(-n+2){border-bottom:none}
  .config-item .label{font-size:12px;color:var(--text-secondary);font-weight:500;margin-bottom:4px}
  .config-item .value{font-family:'DM Mono',monospace;font-size:13px;color:var(--text);font-weight:500;word-break:break-all}
  .config-item .value.tag{
    display:inline-flex;gap:6px;flex-wrap:wrap;
  }
  .tag-pill{
    background:var(--accent-warm-light);
    color:var(--accent-warm);
    font-family:'DM Mono',monospace;
    font-size:11px;font-weight:600;
    padding:3px 10px;
    border-radius:20px;
    letter-spacing:.3px;
  }

  /* ── links ── */
  .links{
    display:flex;gap:10px;flex-wrap:wrap;
  }
  .link-btn{
    display:inline-flex;align-items:center;gap:8px;
    padding:10px 18px;
    background:var(--card);
    border:1px solid var(--border);
    border-radius:8px;
    font-family:'DM Sans',sans-serif;
    font-size:13px;font-weight:600;
    color:var(--text);
    text-decoration:none;
    transition:all .15s ease;
    box-shadow:var(--shadow);
    cursor:pointer;
  }
  .link-btn:hover{
    border-color:var(--accent);
    color:var(--accent);
    box-shadow:var(--shadow-lg);
    transform:translateY(-1px);
  }
  .link-btn svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

  /* ── footer ── */
  .footer{
    text-align:center;
    padding-top:32px;
    font-size:12px;
    color:var(--text-secondary);
    letter-spacing:.2px;
  }
  .footer span{font-weight:600;color:var(--text)}

  /* ── two-column layout for status + links ── */
  .row-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:640px){
    .row-2{grid-template-columns:1fr}
    .config-grid{grid-template-columns:1fr}
    .config-item:nth-child(odd){padding-right:0;border-right:none}
    .config-item:nth-child(even){padding-left:0}
  }
</style>
</head>
<body>
<div class="shell">

  <div class="header">
    <div class="header-icon">
      <svg viewBox="0 0 24 24"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 4v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
    </div>
    <div>
      <h1>FreightClub Integration</h1>
      <p>Automated LTL freight quoting for Turn Offroad</p>
    </div>
  </div>

  <div class="row-2">
    <div class="card">
      <div class="card-label">
        <svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        System Status
      </div>
      <div class="status-row">
        <div class="status-item">
          <span class="label">Server</span>
          <span class="status-dot">Online</span>
        </div>
        <div class="status-item">
          <span class="label">Uptime</span>
          <span class="value">${uptimeStr}</span>
        </div>
      </div>
      <div class="divider"></div>
      <div class="status-item">
        <span class="label">Last checked</span>
        <span class="value" style="font-size:12px;color:var(--text-secondary)">${timestamp}</span>
      </div>
    </div>

    <div class="card">
      <div class="card-label">
        <svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Quick Links
      </div>
      <div class="links" style="flex-direction:column">
        <a class="link-btn" href="https://app.freightclub.com" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          FreightClub Dashboard
        </a>
        <a class="link-btn" href="/health" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          Health Check Endpoint
        </a>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-label">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      How It Works
    </div>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-content">
          <h3>Order Received</h3>
          <p>Shopify sends the order via webhook. The server checks each product for <strong>LTL</strong> or <strong>Oversize Ground</strong> tags.</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-content">
          <h3>Dimensions Gathered</h3>
          <p>Fetches height, width, length from variant metafields and weight from the product variant.</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-content">
          <h3>Freight Rates Quoted</h3>
          <p>Calls the FreightClub API to get carrier rates. The shipment appears in your FreightClub dashboard under Open Quotes.</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-content">
          <h3>Team Notified</h3>
          <p>An email is sent to your team with the order details, shipping tier, and a link to review and book the shipment.</p>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-label">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Configuration
    </div>
    <div class="config-grid">
      <div class="config-item">
        <div class="label">Webhook endpoint</div>
        <div class="value">/api/webhooks/shopify-order</div>
      </div>
      <div class="config-item">
        <div class="label">Notifications sent to</div>
        <div class="value">${notifyEmail}</div>
      </div>
      <div class="config-item">
        <div class="label">Monitored tags</div>
        <div class="value tag">
          <span class="tag-pill">LTL</span>
          <span class="tag-pill">Oversize Ground</span>
        </div>
      </div>
      <div class="config-item">
        <div class="label">Tracking poll interval</div>
        <div class="value">Every hour</div>
      </div>
    </div>
  </div>

  <div class="footer">Built by <a href="https://www.cloveode.com/" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600;text-decoration:none">CloveOde</a></div>

</div>
</body>
</html>`;

  res.type('html').send(html);
});

// ---------------------------------------------------------------------------
// Core endpoints
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    startedAt: serverState.startedAt,
    lastOperation: serverState.lastOperation,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.use('/api/rates', ratesRouter);
app.use('/api/booking', bookingRouter);
app.use('/api/tracking', trackingRouter);
app.use('/api/webhooks', webhooksRouter);

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  logger.info(`FreightClub integration server listening on port ${PORT}`);
  trackingPoller.start();
});

// Expose serverState so routes can update lastOperation if needed
module.exports = { app, serverState };
