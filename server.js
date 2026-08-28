require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const authRoutes = require('./routes/auth');
const sightingsRoutes = require('./routes/sightings');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // running behind nginx, or Vercel's edge network

// index.html/admin.html each carry one inline <script type="importmap">
// (required so the 3D countdown's Three.js addon modules can resolve their
// bare "three" imports). CSP blocks inline scripts by default, and the two
// usual fixes are both wrong here: 'unsafe-inline' would allow ANY inline
// script, and a content hash is brittle (breaks on the next whitespace edit).
// A per-request nonce is the correct fix — generate one before helmet runs,
// thread it into both the CSP header and the HTML.
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

// Default CSP only allows scripts from 'self'; the 3D countdown (Three.js)
// and confetti (lottie-web) libraries load from CDNs, so those origins need
// an explicit allowance under script-src. The 3D countdown's font also gets
// fetched at runtime (FontLoader's internal fetch()), which CSP governs
// under connect-src, not script-src — that needs its own allowance or the
// font request gets silently blocked even with script-src fixed. Everything
// else stays on helmet's strict defaults.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': [
        "'self'",
        'https://cdnjs.cloudflare.com',
        'https://cdn.jsdelivr.net',
        (req, res) => `'nonce-${res.locals.cspNonce}'`,
      ],
      'connect-src': ["'self'", 'https://cdn.jsdelivr.net'],
    },
  },
}));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// index: false — the public / and private /admin documents are served by the
// explicit routes below (which need to run their own logic), not by static's
// default directory-index behavior.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Reads the HTML fresh from disk each request (same as sendFile — no build
// step, edits show up on refresh) and stamps in this request's CSP nonce.
function sendHtmlWithNonce(res, filename) {
  const html = fs.readFileSync(path.join(__dirname, 'public', filename), 'utf8');
  res.type('html').send(html.replaceAll('%%CSP_NONCE%%', res.locals.cspNonce));
}

// Public, unauthenticated landing page: the "next predicted roam" hero + heatmap.
app.get('/', (req, res) => {
  sendHtmlWithNonce(res, 'index.html');
});

// Private dashboard. Always serves the same document — admin.html's own
// client-side /api/auth/me check decides whether to show the login/register
// form or the dashboard. (An earlier version redirected cookie-less visitors
// to "/" here, which sounded like a reasonable gate but actually made it
// impossible for a brand-new visitor to ever reach the login form at all —
// "Team sign in" would just bounce them straight back.) The real security
// boundary is requireAuth/requireAdmin on the API, not this page-level route.
app.get('/admin', (req, res) => {
  sendHtmlWithNonce(res, 'admin.html');
});

// Slow down brute-force attempts on login/register.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// The anonymous "spot it now" button is public and unauthenticated, so it
// needs its own abuse guard — generous enough for genuine excited clicking,
// tight enough that it can't be used to spam writes or force Gemini spend
// (it deliberately never triggers a Gemini recompute either, see routes/sightings.js).
const anonymousLogLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Slow down — try again in a few minutes.' },
});
app.use('/api/sightings/anonymous', anonymousLogLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/sightings', sightingsRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// Public: lets the frontend render timestamps in the same timezone the server
// buckets the heatmap in, instead of each viewer's own browser timezone (which
// would disagree with the heatmap and could even show a different weekday).
app.get('/api/config', (req, res) => {
  res.json({ timezone: process.env.TIMEZONE || 'UTC' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Predict the Gank server listening on port ${PORT}`);
  });
}

module.exports = app;
