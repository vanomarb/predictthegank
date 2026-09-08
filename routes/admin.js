/**
 * The admin console's Config tab: what the prediction machinery is set to, and
 * every knob on it.
 *
 * WHY IT EXISTS. All of this used to live in environment variables, which on
 * Vercel means an env edit and a redeploy to change the working day — and nothing
 * on any page said which model produced the prediction in front of you, when it
 * last ran, or whether the job that refreshes it was even pointed at the right
 * hour. The answer to "why hasn't this changed since Tuesday?" was in a log
 * nobody reads.
 *
 * WHAT IS NOT EDITABLE, AND WHY:
 *
 *   Secrets. GEMINI_API_KEY and CRON_SECRET are reported as set or not set and
 *   never read. A value editable from a browser session is a value a stolen
 *   browser session can edit.
 *
 *   The cron schedule. It lives in vercel.json, which is deployed. A control here
 *   would be lying, so instead it is shown and checked against the working day,
 *   loudly, when the two drift apart.
 *
 *   Last analysis, phases, moments. Facts about what happened, not settings.
 *
 * Every route is admin-only. The refresh route spends real money at a
 * third-party API and is rate-limited in server.js as well.
 */

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { recomputeSmartPrediction, readStoredSmartPrediction } = require('./sightings');
const { listModels } = require('../services/gemini');
const settings = require('../services/settings');
const { describeSchedule, h12 } = require('../services/cron-schedule');

const router = express.Router();

router.use(requireAuth, requireAdmin);

// Minutes since midnight, on the same 12-hour clock as the rest of the app.
const clock = (minutes) => h12(Math.floor(minutes / 60), minutes % 60);

// The editable settings, in the shape the dashboard renders them: the value, how
// to display it, where it came from, and who last changed it. Built from the spec
// table, so a new setting reaches the UI without this route being touched.
async function configPayload() {
  const meta = await settings.settingsMeta();
  const field = (name, extra) => {
    const { value, source } = settings.resolve(name);
    const spec = settings.SPEC[name];
    return {
      value,
      source,                       // admin | environment | default
      env: spec.env,
      fromEnvironment: process.env[spec.env] || null,
      default: spec.fallback,
      ...(meta[name] || {}),
      ...extra,
    };
  };
  return {
    aiModel: field('aiModel'),
    timeZone: field('timeZone'),
    workStart: field('workStart', { display: h12(settings.get('workStart')) }),
    workEnd: field('workEnd', { display: h12(settings.get('workEnd')) }),
    workDays: field('workDays', {
      display: settings.get('workDays').map((d) => settings.DAY_NAMES[d]).join(', '),
    }),
    breaks: field('breaks', {
      display: settings.get('breaks').map((b) => `${clock(b.start)}–${clock(b.end)}`).join(', ')
        || 'none',
      text: settings.breaksToText(settings.get('breaks')),
    }),
    phaseCeiling: field('phaseCeiling'),
    momentCeiling: field('momentCeiling'),
  };
}

/**
 * GET /api/admin/config
 */
router.get('/config', async (req, res, next) => {
  try {
    const office = settings.office();
    const [config, stored] = await Promise.all([configPayload(), readStoredSmartPrediction()]);

    // What the page is ACTUALLY showing. A stored answer that no longer survives
    // the office rules — a legacy row, or one written before a work-hours change
    // — means the page has silently fallen back to the statistical model, and
    // that is the single most useful thing to surface here.
    const windows = (stored && stored.windows) || [];
    const usable = windows.filter((w) => Array.isArray(w.moments) && w.moments.length > 0);

    res.json({
      config,
      status: {
        provider: 'Google Gemini',
        api: 'generativelanguage.googleapis.com (v1beta)',
        // Whether, never what.
        keyConfigured: !!process.env.GEMINI_API_KEY,
        cronSecretConfigured: !!process.env.CRON_SECRET,
        servingToPage: usable.length > 0 ? 'ai' : 'statistical',
        producedBy: (stored && stored.model) || null,
        computedAt: (stored && stored.computedAt) || null,
        fromSightings: (stored && stored.sightingsTotal) || null,
        phases: usable.length,
        moments: usable.reduce((n, w) => n + w.moments.length, 0),
        wildcards: ((stored && stored.wildcards) || []).length,
        droppedPhases: windows.length - usable.length,
        legacyRow: !!(stored && stored.legacy),
      },
      cron: describeSchedule(office.timeZone, office.workHours),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/admin/config   { workEnd: 17, breaks: "12:00-13:00" }
 *
 * Any subset of the editable fields. A field sent as null or "" drops its
 * override and hands that one field back to the environment.
 *
 * ALL OR NOTHING. Every value is validated before any is written, so a form with
 * one bad field cannot leave the office half-configured — which for these
 * settings means a working day that ends before it starts, or a timezone every
 * Intl call in the app throws on.
 */
router.put('/config', async (req, res, next) => {
  try {
    const body = req.body || {};
    const unknown = Object.keys(body).filter((k) => !settings.FIELDS.includes(k));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown setting: ${unknown.join(', ')}` });
    }
    const names = Object.keys(body);
    if (names.length === 0) {
      return res.status(400).json({ error: 'No known setting in that request.' });
    }

    // Validate the lot before writing any of it.
    for (const name of names) {
      const value = body[name];
      if (value === null || value === '') continue; // a clear is always allowed
      const spec = settings.SPEC[name];
      const parsed = spec.parse(typeof value === 'string' ? value : spec.text(value));
      if (parsed === null || !spec.check(parsed)) {
        return res.status(400).json({ error: `${name}: not a value this setting accepts.` });
      }
    }

    // The working day is the one cross-field rule, and it has to be checked
    // against the values as they WILL BE, not as they are: sending start=10 and
    // end=9 together must fail even though each is individually fine.
    const pending = { workStart: settings.get('workStart'), workEnd: settings.get('workEnd') };
    for (const name of ['workStart', 'workEnd']) {
      if (!(name in body)) continue;
      pending[name] = body[name] === null || body[name] === ''
        ? settings.SPEC[name].fallback
        : settings.SPEC[name].parse(String(body[name]));
    }
    if (pending.workEnd <= pending.workStart) {
      return res.status(400).json({
        error: `The working day would end at ${h12(pending.workEnd)}, at or before it starts at `
          + `${h12(pending.workStart)}.`,
      });
    }

    for (const name of names) {
      const value = body[name];
      if (value === null || value === '') await settings.clearField(name);
      else await settings.setField(name, value, req.user.id);
    }

    console.log(`[admin] config changed by account ${req.user.id}: ${names.join(', ')}`);
    return res.json({ ok: true, config: await configPayload() });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    return next(e);
  }
});

/**
 * GET /api/admin/config/models
 *
 * The recommended models this key can actually use. Live rather than hardcoded,
 * because a list in the source rots: gemini-3.6-flash did not exist when this app
 * was written.
 */
router.get('/config/models', async (req, res, next) => {
  try {
    const inUse = settings.get('aiModel');
    const result = await listModels(inUse);
    if (result.error) return res.status(502).json({ error: result.error });
    return res.json({ models: result.models, inUse, offList: !!result.offList });
  } catch (e) {
    return next(e);
  }
});

/**
 * GET /api/admin/config/timezones
 *
 * The zones this runtime knows, so the timezone field is a list and not a
 * spelling test — an unknown zone makes every Intl call in the app throw.
 */
router.get('/config/timezones', (req, res) => {
  const zones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [];
  res.json({ zones, inUse: settings.get('timeZone') });
});

/**
 * POST /api/admin/config/refresh
 *
 * Runs the daily analysis now, so an admin who has just changed the model or the
 * working day does not have to wait until 6pm to find out whether it worked.
 *
 * This is not the trigger that was removed from the logging path. That one fired
 * automatically on every sighting — dozens of calls a day to re-answer a question
 * whose answer barely moves. This is a person deciding to spend one call.
 */
router.post('/config/refresh', async (req, res, next) => {
  try {
    const result = await recomputeSmartPrediction();
    console.log(`[admin] manual refresh by account ${req.user.id}:`, JSON.stringify(result));
    return res.status(result.ok ? 200 : 502).json(result);
  } catch (e) {
    return next(e);
  }
});

module.exports = router;
