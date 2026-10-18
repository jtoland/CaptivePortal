const path = require('path');
const https = require('https');
const express = require('express');
const { seed, cleanup, DATA_DIR, publicUrl } = require('./db');

seed();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1); // set TRUST_PROXY=1 only if you put your own reverse proxy in front
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '15mb' }));

// Captive network assistants cache aggressively - never cache portal pages. Plus baseline security headers:
// pages may only be framed by this site (the admin previews portal pages), and the admin itself never.
app.use((req, res, next) => {
  const admin = req.path.startsWith('/admin');
  res.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': admin ? 'DENY' : 'SAMEORIGIN',
    'Content-Security-Policy': `frame-ancestors ${admin ? "'none'" : "'self'"}; base-uri 'self'; form-action 'self' https:; object-src 'none'`,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), {
  maxAge: '1d',
  // Uploaded SVGs must never run script on this origin.
  setHeaders: (res) => res.set({ 'Content-Security-Policy': "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src * data:; media-src *", 'X-Content-Type-Options': 'nosniff' }),
}));
app.get('/healthz', (req, res) => res.json({ ok: true }));


app.use('/api', require('./api'));
app.use('/admin', require('./admin'));
app.use('/', require('./portal'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

setInterval(cleanup, 15 * 60_000).unref();
require('./ssidsync').start();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Captive portal listening on :${port} (HTTP)`);
  console.log(`Admin UI: http://<this-host>/admin   public address: ${publicUrl() || '(not set)'}`);
});

// HTTPS starts once a certificate has been issued (Settings → Hotspot setup), and picks up renewals without a restart.
const tls = require('./tls');
const httpsPort = Number(process.env.HTTPS_PORT || 3443);
let httpsServer = null;
function startHttps() {
  const opts = tls.secureContextOptions();
  if (!opts) return;
  try {
    if (httpsServer) { httpsServer.setSecureContext(opts); console.log('[tls] reloaded certificate'); return; }
    httpsServer = https.createServer(opts, app).listen(httpsPort, () => console.log(`Captive portal listening on :${httpsPort} (HTTPS)`));
  } catch (e) {
    console.error('[tls] could not start HTTPS:', e.message);
  }
}
startHttps();
tls.onChange(startHttps);
tls.startRenewals();
require('./backup').startSchedule();
