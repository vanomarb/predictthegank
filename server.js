require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const authRoutes = require('./routes/auth');
const { router: sightingsRoutes } = require('./routes/sightings');
const cronRoutes = require('./routes/cron');
const adminRoutes = require('./routes/admin');
const { getWorkHours, getBreaks, getTimeZone } = require('./services/work-hours');
// The schedule arithmetic lives in one place now, shared with the admin
// dashboard, which was about to grow a second copy of it.
const { utcHourFor, refreshJob } = require('./services/cron-schedule');

// COUNTDOWN_OVERRIDE_MS forces the hero countdown to a fixed starting value, in
// milliseconds, so the states that only happen in the last minute of a window —
// the red urgent pulse, the 1-minute and 30-second alerts — can be seen on
// demand instead of by waiting for a real window to come round.
//
// Testing only, and deliberately loud about it: the boot log says so, and the
// pages show a badge next to the countdown, because a page quietly displaying a
// fabricated countdown is worse than no test tool at all.
function getCountdownOverrideMs() {
  const raw = process.env.COUNTDOWN_OVERRIDE_MS;
  if (!raw) return null;
  const ms = Number.parseInt(raw, 10);
  if (!Number.isInteger(ms) || ms <= 0) {
    console.warn(`COUNTDOWN_OVERRIDE_MS="${raw}" is not a positive integer — ignoring it.`);
    return null;
  }
  return ms;
}

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

// Default CSP only allows scripts from 'self'; Tailwind, the 3D countdown
// (Three.js) and the Lottie player all load from cdn.jsdelivr.net, so that one
// origin needs an explicit allowance under script-src. It is the only CDN the
// app uses — lottie-web moved off cdnjs when it switched to the svg-only build,
// so cdnjs is no longer allowed here at all.
//
// cdn.jsdelivr.net is also allowed under connect-src, for one reason: source
// maps. @tailwindcss/browser ends with a //# sourceMappingURL comment pointing
// at cdn.jsdelivr.net/sm/<hash>.map, and a browser with devtools open fetches
// it — a fetch, so connect-src governs it, not script-src. Without the
// allowance every page load with devtools open logs a CSP violation for a file
// that only exists to make a third-party library debuggable.
//
// This is a smaller concession than it looks: the same host is already trusted
// to execute script here, which is strictly more power than being allowed to
// answer a fetch. Nothing else the app does needs a cross-origin request — the
// countdown's typeface was deliberately subsetted to our own origin (see
// scripts/generate-timer-typeface.js) so it does not.
//
// Everything else stays on helmet's strict defaults.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': [
        "'self'",
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
// tight enough that it can't be used to spam writes. Nothing on a request path
// spends Gemini credit any more; that is the daily cron's job alone.
const anonymousLogLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Slow down — try again in a few minutes.' },
});
app.use('/api/sightings/anonymous', anonymousLogLimiter);

// The dashboard's "run the analysis now" button spends a real API call at a
// third-party, and the free tier allows twenty a minute. Admin-only already, but
// an admin holding down a button is still an admin running up a bill, and a
// prediction only moves once a day anyway.
const aiRefreshLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'The analysis was run recently — give it a few minutes.' },
});
app.use('/api/admin/config/refresh', aiRefreshLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/sightings', sightingsRoutes);
// Scheduled work, called from outside. Authorized by CRON_SECRET, not a cookie
// — see routes/cron.js.
app.use('/api/cron', cronRoutes);
// The dashboard's window onto the prediction machinery, and the model knob.
// Admin-only inside the router itself; the refresh route spends real money at a
// third-party API, so it is rate-limited above as well.
app.use('/api/admin', adminRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// Public: lets the frontend render timestamps in the same timezone the server
// buckets the heatmap in, and gate the "log a sighting" buttons on the office's
// working day rather than each viewer's local clock.
app.get('/api/config', (req, res) => {
  res.json({
    timezone: getTimeZone(),
    workHours: getWorkHours(),
    breaks: getBreaks(),
    countdownOverrideMs: getCountdownOverrideMs(),
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  // A malformed request body is the CALLER's mistake, and express.json marks it
  // as such with statusCode 400. Flattening everything to 500 told an API client
  // "the server is broken" when the truth was "your JSON has a typo in it", and
  // sent someone looking in the wrong place. Only client errors are passed
  // through; anything without a 4xx on it stays a 500, and the message stays
  // generic either way so nothing internal leaks.
  const status = Number.isInteger(err.status || err.statusCode)
    && (err.status || err.statusCode) >= 400
    && (err.status || err.statusCode) < 500
    ? (err.status || err.statusCode)
    : 500;
  res.status(status).json({
    error: status === 400 ? 'That request could not be read.' : 'Something went wrong.',
  });
});

// vercel.json's cron schedule is a fixed UTC string; when the working day ends
// is configuration. Change TIMEZONE or WORK_HOURS_END and the two drift apart
// with no symptom other than the prediction refreshing at the wrong time of day,
// which nobody would ever notice. So they are compared out loud at boot.
function warnIfCronScheduleDrifted() {
  const job = refreshJob();
  if (!job) return; // no vercel.json (a VPS deploy) — nothing to check against
  const scheduled = Number.parseInt(String(job.schedule).split(' ')[1], 10);
  const timeZone = getTimeZone();
  const want = utcHourFor(getWorkHours().end, timeZone);
  if (scheduled === want) return;
  console.warn(`vercel.json runs the prediction refresh at ${scheduled}:00 UTC, but the working `
    + `day ends at ${getWorkHours().end}:00 ${timeZone}, which is ${want}:00 UTC. `
    + `Change the schedule to "0 ${want} * * *" (or ignore this on a half-hour-offset timezone).`);
}

// AT MODULE LOAD, not inside listen().
//
// These checks used to live in the listen() callback, under
// `require.main === module`. On Vercel nothing calls listen — api/index.js
// requires this file and hands the app to the platform — so the one set of
// warnings that says "your scheduled job cannot work" never printed in the only
// environment where the scheduled job is someone else's to trigger. They ran
// faithfully on the laptop, where the developer could already see everything,
// and went silent in production.
//
// Cheap, synchronous, and once per cold start.
function reportConfigProblems() {
  const override = getCountdownOverrideMs();
  if (override !== null) {
    console.warn(`COUNTDOWN_OVERRIDE_MS=${override} is set — the countdown on both pages is FAKE `
      + '(starts at that value and ticks to zero on load). Unset it for real predictions.');
  }
  if (!process.env.CRON_SECRET) {
    console.warn('CRON_SECRET is not set — /api/cron/refresh-prediction will refuse every call, '
      + 'so the Gemini prediction will never be recomputed. On Vercel, set it in the project\u2019s '
      + 'environment variables: the platform then sends it as a Bearer token with every cron run.');
  }
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY is not set — the daily refresh will run and do nothing, leaving '
      + 'the statistical prediction in place.');
  }
  warnIfCronScheduleDrifted();
}

reportConfigProblems();

// Load the stored settings before the first request rather than after it. Reads
// never block, so without this the very first request on a cold start would
// answer from the environment while the snapshot was still loading — briefly
// serving the wrong working day to whoever arrived first.
require('./services/settings').primeSettings()
  .catch((e) => console.error('[settings] initial load failed:', e.message));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Predict the Gank server listening on port ${PORT}`);
  });
}

module.exports = app;
