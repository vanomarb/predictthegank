/**
 * The Gemini prediction: the whole thing — phases, the moments inside them,
 * their likelihoods, and the wildcards between them.
 *
 * WHAT IT IS ASKED FOR. Everything the page displays as a prediction. The model
 * picks the hour ranges, the exact minute of each sure/likely/maybe moment
 * inside a range, the percentage on each of those moments, and the wildcard
 * minute in the gap between two phases.
 *
 * IT USED TO BE ASKED FOR RANGES ONLY, on the reasoning that a model guessing a
 * minute would be inventing precision, so the minutes and percentages were
 * filled in afterwards by the statistical engine — the same engine that builds
 * the non-AI prediction. The consequence was that when the model picked the same
 * hours the counts already ranked highest, which with a clean pattern is every
 * time, the "AI" prediction came out byte-identical to the statistical one:
 * same minutes, same percentages, differing only by a confidence number and a
 * sentence. An AI analysis that cannot disagree with the analysis it is meant to
 * improve on is not an analysis, and the card said "AI" over numbers the model
 * had never seen.
 *
 * So it now owns the whole prediction and can differ from the statistical model
 * in every value. The statistical model remains, unchanged, as the fallback for
 * when there is no key, no stored answer, or the call fails.
 *
 * The one thing still computed here rather than asked for is each range's
 * all-time sighting count, because that is a measurement of what happened, not
 * a prediction of what will — see routes/sightings.js.
 *
 * The prompt states the office's rules — work hours, work days, break times —
 * and sanitizeWindows enforces every one of them on the way back, down to the
 * individual minute, because a model told to stay out of lunch will occasionally
 * answer 12:30 anyway. The prompt is a request; the sanitizer is the guarantee.
 */

const API_HOST = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta';

// A model name goes straight into the request URL's PATH:
//
//   https://generativelanguage.googleapis.com/v1beta/models/<name>:generateContent
//
// so it is not free text. A value containing a slash or a dot-dot could point
// the request at another endpoint entirely, and one containing a colon could
// change the method being called. Lowercase letters, digits, dots and hyphens
// only, starting with an alphanumeric - the shape every model Google publishes
// actually has.
//
// The rule lives here, next to the URL it protects, and services/settings.js
// imports it rather than keeping a second copy that could drift.
const MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const isValidModel = (name) => typeof name === 'string' && MODEL_PATTERN.test(name);

// The model is resolved per call, not at module load.
//
// It was `process.env.GEMINI_MODEL` read once into a const, which on Vercel
// means an environment-variable edit and a redeploy to try a different model —
// and no way for anyone reading the page to see which model produced the
// prediction in front of them. An admin can set it from the dashboard now; see
// services/settings.js for the precedence, and note the name is validated there
// because it lands in the request URL's path.
const endpointFor = (model) => `${API_HOST}/${API_VERSION}/models/${model}:generateContent`;

// A SHORT LIST, on purpose.
//
// The provider publishes about forty models to this key, most of which have no
// business here: image, speech and embedding models that would fail on the first
// call, -lite variants that are worse at this than the flash they came from, and
// previews that can be withdrawn without notice. A dropdown of forty is not a
// choice, it is a puzzle.
//
// So: the general-purpose text models worth running this prompt on, strongest
// and newest first. Anything not on this list is still reachable by setting
// GEMINI_MODEL in the environment — and if that is set to something off-list,
// listModels adds it, because a dashboard that cannot show you the model you are
// running is worse than useless.
//
// The "-latest" aliases are deliberately absent: they move under you, and
// "which model produced this prediction?" stops having an answer.
const RECOMMENDED_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
];

// The recommended models this key can actually use, checked against the
// provider rather than trusted from the source: a list in the source rots, and
// gemini-3.6-flash did not exist when this app was written.
async function listModels(inUse) {
  if (!process.env.GEMINI_API_KEY) return { error: 'no API key configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_HOST}/${API_VERSION}/models`
      + `?key=${process.env.GEMINI_API_KEY}&pageSize=200`, { signal: controller.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let reason = detail.slice(0, 200);
      try { reason = JSON.parse(detail).error?.message || reason; } catch (e) { /* keep raw */ }
      return { error: `listing models failed (${res.status}): ${reason}` };
    }
    const data = await res.json();
    const available = new Set((data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((name) => isValidModel(name)));
    // Curated order, not alphabetical: the list is a recommendation.
    const models = RECOMMENDED_MODELS.filter((m) => available.has(m));
    // Never hide the model actually in force, however it was set.
    if (isValidModel(inUse) && !models.includes(inUse)) models.unshift(inUse);
    return { models, offList: isValidModel(inUse) && !RECOMMENDED_MODELS.includes(inUse) };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}
// Comfortably above the 4.6-5.1s the call measures at, and comfortably below
// the function's maxDuration in vercel.json — so a slow day aborts here, with a
// log line saying so, rather than being killed by the platform mid-flight.
const TIMEOUT_MS = 20000;
const MAX_SIGHTINGS_SENT = 500;
// Listing models is a metadata call, not a generation — quick, and it blocks an
// admin staring at a dropdown, so it gets a short leash of its own.
const LIST_TIMEOUT_MS = 6000;

// ONE retry, because this runs once a day.
//
// A single failed call means the prediction does not move for twenty-four hours,
// and both failures seen in practice are the retryable kind: a request that
// stalls past the timeout, and a 429 from the free tier's per-minute quota that
// says "retry in 6s" in its own body. Retrying once turns both into a slower
// success. Any more than once, and a genuinely broken request — a rejected
// schema, say — would be paid for repeatedly to no purpose.
//
// TIMEOUT_MS + RETRY_DELAY_MS + TIMEOUT_MS has to stay inside the function's
// maxDuration in vercel.json, or the platform kills the process mid-retry and
// the log says nothing about why.
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_RATIONALE = 200;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The three tiers a moment inside a phase can carry, strongest first. The model
// assigns them: which of its own predicted minutes it is most sure of is a
// judgement about the pattern, and it is the thing being asked for a judgement.
const MOMENT_TIERS = ['sure', 'likely', 'maybe'];

const MOMENT_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'string', enum: MOMENT_TIERS, description: 'sure, likely or maybe' },
    hour: { type: 'integer', description: '0-23, local hour of this exact moment' },
    minute: { type: 'integer', description: '0-59, local minute of this exact moment' },
    likelihood: { type: 'integer', description: '0-100, chance of a roam in this exact minute' },
  },
  required: ['tier', 'hour', 'minute', 'likelihood'],
};

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    windows: {
      type: 'array',
      description: 'Candidate roam phases for a normal work day, in clock order, earliest first.',
      items: {
        type: 'object',
        properties: {
          predictedHourStart: { type: 'integer', description: '0-23, local hour, inclusive' },
          predictedHourEnd: { type: 'integer', description: '1-24, local hour, exclusive' },
          confidence: { type: 'number', description: '0 to 1, how consistently this range recurs' },
          rationale: { type: 'string', description: 'One short sentence, plain language, about this range' },
          moments: {
            type: 'array',
            description: 'The exact minutes inside this range, one per tier, at most three.',
            items: MOMENT_SCHEMA,
          },
        },
        required: ['predictedHourStart', 'predictedHourEnd', 'confidence', 'rationale', 'moments'],
      },
    },
    wildcards: {
      type: 'array',
      description: 'Low-probability moments in the GAPS BETWEEN phases, never inside one.',
      items: {
        type: 'object',
        properties: {
          hour: { type: 'integer', description: '0-23, local hour' },
          minute: { type: 'integer', description: '0-59, local minute' },
          likelihood: { type: 'integer', description: '0-100, and it should be low' },
          rationale: { type: 'string', description: 'One short clause on why a roam might happen here' },
        },
        required: ['hour', 'minute', 'likelihood', 'rationale'],
      },
    },
  },
  required: ['windows'],
};

const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function describeBreaks(breaks) {
  if (!breaks || breaks.length === 0) return 'There are no scheduled breaks.';
  return `Break times, when nobody is at their desk and HR does not roam: `
    + `${breaks.map((b) => `${hhmm(b.start)}-${hhmm(b.end)}`).join(', ')}.`;
}

function buildPrompt({ sightingTimestamps, heatmap, total, workHours, breaks, timeZone, maxWindows }) {
  const workDays = workHours.days.map((d) => DAY_NAMES[d]).join(', ');
  return `You are analyzing timestamps of sightings of an office HR person roaming past `
    + `coworkers' desks, logged by a team for fun.\n\n`

    + `THE OFFICE\n`
    + `Timezone: ${timeZone}. All hours below and in your answer are local hours in it.\n`
    + `Work days: ${workDays}. Sightings on any other day are noise — the team is not in.\n`
    + `Work hours: ${workHours.start}:00 to ${workHours.end}:00 (start inclusive, end exclusive).\n`
    + `${describeBreaks(breaks)}\n\n`

    + `THE DATA\n`
    + `Unix timestamps (seconds) of the most recent sightings, newest first:\n`
    + `${JSON.stringify(sightingTimestamps)}\n\n`
    + `Aggregate day-of-week x hour-of-day counts (heatmap[day][hour], day 0=Sunday):\n`
    + `${JSON.stringify(heatmap)}\n\nTotal sightings: ${total}.\n\n`

    + `WHAT TO RETURN\n`
    + `Up to ${maxWindows} candidate ROAM PHASES for a normal work day: the stretches of the `
    + `day this person tends to be out and about. Each phase is a whole-hour range, `
    + `usually one hour long. Return them in clock order, earliest first.\n\n`

    + `Inside each phase, return its MOMENTS: the exact minutes a roam is most likely, `
    + `one per tier, at most three per phase.\n`
    + `  • "sure"   — the single minute you would bet on in this range\n`
    + `  • "likely" — the next most probable minute in it\n`
    + `  • "maybe"  — a third, weaker one\n`
    + `Give each moment a likelihood: 0-100, the chance a roam happens in THAT EXACT `
    + `MINUTE. A prediction of 14:07 counts as correct only for the 60 seconds from `
    + `14:07:00 to 14:07:59, so these numbers should be modest and honest, and "sure" `
    + `must carry the highest of the three.\n\n`

    + `Also return WILDCARDS: single low-probability minutes in the GAPS BETWEEN phases, `
    + `at most one per gap. These are the off-pattern roams — the unexpected walk-past `
    + `— so their likelihood should be genuinely low.\n\n`

    + `Rules, all of which are hard requirements:\n`
    + `1. Every phase, every moment and every wildcard must lie within work hours `
    + `(${workHours.start}:00-${workHours.end}:00, end exclusive).\n`
    + `2. NOTHING may fall inside a break time — not a phase, not a moment, not a `
    + `wildcard, and not the minute a break ends on either. HR is not roaming the desks `
    + `during lunch, so sightings logged then say nothing about the pattern: weight them `
    + `at zero.\n`
    + `3. Phases must not overlap each other, and should not be adjacent: leave at least `
    + `an hour of gap between one phase ending and the next beginning — that gap is `
    + `where a wildcard goes.\n`
    + `4. Every moment must fall inside its own phase's range. A phase of 9-10 may only `
    + `contain moments from 9:00 to 9:59.\n`
    + `5. Every wildcard must fall in a gap BETWEEN two phases, or after the last one, `
    + `and never inside any phase's range.\n`
    + `6. Base the pattern on time-of-day clustering across work days only. Ignore rows `
    + `for non-work days in the heatmap entirely. Weight recent sightings more heavily `
    + `than old ones.\n`
    + `7. Fewer, stronger phases beat ${maxWindows} weak ones. Return only the ranges the `
    + `data actually supports, and only the moments in them you can justify.\n\n`

    + `YOUR ANSWER IS THE PREDICTION\n`
    + `Every range, minute and percentage the page shows comes from you. Nothing is `
    + `recomputed afterwards and nothing is averaged with another model, so a minute you `
    + `pick badly is a minute the team stands up for. The timestamps and the heatmap are `
    + `all the evidence there is — read the clustering in them and answer from it, not `
    + `from what an office day is generally like.\n\n`

    + `confidence is how consistently that whole range actually recurs — do not inflate `
    + `it. rationale is one short, plain-language sentence about that range, for a `
    + `non-technical reader to enjoy; write about the range, not about the whole day.`;
}

// Is this minute-of-day inside a break? Breaks are end-exclusive everywhere in
// the app, and the end minute itself is usable — 15:30 is the first minute back
// at your desk after a 15:15-15:30 break, not part of it.
const inBreak = (minuteOfDay, breaks) =>
  (breaks || []).some((b) => minuteOfDay >= b.start && minuteOfDay < b.end);

// THE SANITIZERS MUST BE IDEMPOTENT.
//
// They run twice on every prediction: once in getSmartWindows on the way back
// from the model, and again in GET /stats on the way out of storage, so that a
// change to WORK_HOURS or BREAK_TIMES takes effect immediately rather than at
// the next cron run. That means the second pass is reading its own output.
//
// It was reading the wrong field names. The model answers `likelihood` and
// `rationale`; the first pass renames those to `pct` and `note`; the second pass
// looked for `likelihood` again, found nothing, and defaulted every percentage
// on the page to 0%. Every AI moment displayed "0%" — a number the model never
// gave and that no reader could act on.
//
// So both spellings are accepted everywhere, and sanitizing an already-sanitized
// answer returns it unchanged.
const likelihoodOf = (o) => (o.likelihood != null ? o.likelihood : o.pct);
const noteOf = (o) => (o.rationale != null ? o.rationale : o.note);

// One predicted minute, checked against every rule that applies to a minute.
// Returns minutes-since-midnight, or null if the answer cannot be used.
//
// This is the guarantee that replaced a structural one. When the minutes were
// computed here, they came out of a quarter-hour slicer that had already dropped
// every quarter touching a break, so "nothing is ever predicted during lunch"
// held by construction and could not be got wrong. Now a model picks the minute,
// and the only thing standing between 12:30 and the page is this function.
function usableMinute(hour, minute, { workHours, breaks, from, to }) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const at = hour * 60 + minute;
  if (at < workHours.start * 60 || at >= workHours.end * 60) return null;
  if (inBreak(at, breaks)) return null;
  if (from != null && at < from) return null;
  if (to != null && at >= to) return null;
  return at;
}

// The moments inside one phase: at most one per tier, all inside the phase's own
// range, none in a break, in clock order.
function sanitizeMoments(moments, { workHours, breaks, from, to }) {
  const seenTier = new Set();
  const seenMinute = new Set();
  return (Array.isArray(moments) ? moments : [])
    .map((m) => {
      const tier = String(m.tier || '').toLowerCase();
      if (!MOMENT_TIERS.includes(tier)) return null;
      const at = usableMinute(Number(m.hour), Number(m.minute), { workHours, breaks, from, to });
      if (at === null) return null;
      return {
        tier,
        hour: Math.floor(at / 60),
        minute: at % 60,
        // The model's own number, clamped rather than replaced: it is being
        // asked for a judgement, and a judgement outside 0-100 is a typo, not a
        // different judgement.
        pct: Math.min(100, Math.max(0, Math.round(Number(likelihoodOf(m))) || 0)),
      };
    })
    .filter(Boolean)
    // Two "sure" moments in one range would render as two rows claiming to be
    // the strongest. Highest likelihood wins the tier.
    .sort((a, b) => b.pct - a.pct)
    .filter((m) => {
      if (seenTier.has(m.tier) || seenMinute.has(m.hour * 60 + m.minute)) return false;
      seenTier.add(m.tier);
      seenMinute.add(m.hour * 60 + m.minute);
      return true;
    })
    .slice(0, MOMENT_TIERS.length)
    .sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));
}

/**
 * The wildcards: low-probability minutes in the gaps BETWEEN phases.
 *
 * Takes the already-sanitized windows, because "in a gap" is only answerable
 * once you know which ranges are real. A wildcard inside a phase is dropped
 * rather than moved: it contradicts the one thing that makes a wildcard a
 * wildcard, and a phase already has three moments of its own.
 *
 * At most one per gap, the likeliest, so two cards cannot both claim the same
 * stretch of the afternoon.
 */
function sanitizeWildcards(wildcards, { workHours, breaks = [], windows = [] }) {
  const gapOf = (at) => {
    for (let i = 0; i < windows.length; i += 1) {
      if (at >= windows[i].predictedHourStart * 60 && at < windows[i].predictedHourEnd * 60) {
        return null; // inside a phase, not between them
      }
    }
    // Named by the phase it follows; -1 for a wildcard before the first phase.
    let after = -1;
    for (let i = 0; i < windows.length; i += 1) {
      if (at >= windows[i].predictedHourEnd * 60) after = i;
    }
    return after;
  };

  const best = new Map();
  for (const w of (Array.isArray(wildcards) ? wildcards : [])) {
    const at = usableMinute(Number(w.hour), Number(w.minute), { workHours, breaks });
    if (at === null) continue;
    const gap = gapOf(at);
    if (gap === null) continue;
    const cand = {
      hour: Math.floor(at / 60),
      minute: at % 60,
      pct: Math.min(100, Math.max(0, Math.round(Number(likelihoodOf(w))) || 0)),
      note: String(noteOf(w) || '').trim().slice(0, MAX_RATIONALE),
      afterWindow: gap,
    };
    const held = best.get(gap);
    if (!held || cand.pct > held.pct) best.set(gap, cand);
  }
  return [...best.values()].sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));
}

/**
 * Enforces the office's rules on whatever came back.
 *
 * The model is told all of this in the prompt and mostly obeys, but "mostly" is
 * not a property to build a UI on: a phase an hour before anyone arrives, or one
 * sitting on top of lunch, would be rendered as confidently as a real one. Each
 * window is clamped to work hours, dropped if nothing survives, dropped if it is
 * wholly inside a break, and de-duplicated; the strongest `max` survive and come
 * back in clock order.
 *
 * Pure and exported so it can be tested without an API key.
 */
function sanitizeWindows(windows, { workHours, breaks = [], max = 3 }) {
  const seen = new Set();
  return (Array.isArray(windows) ? windows : [])
    .map((w) => {
      const rawStart = Number(w.predictedHourStart);
      const rawEnd = Number(w.predictedHourEnd);
      if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return null;
      // A backwards or empty range is read as the one hour it starts in.
      const end = rawEnd > rawStart ? rawEnd : rawStart + 1;
      // A range that does not touch work hours AT ALL is wrong, not merely
      // over-reaching, and clamping it would invent a phase at 9am out of an
      // answer about 7pm. Only a range that overlaps the working day is worth
      // trimming to fit it: a model answering 8-10 for a 9-18 office has seen a
      // real morning pattern and run past its edge, and 9-10 is the honest
      // reading of that.
      if (end <= workHours.start || rawStart >= workHours.end) return null;
      const hourStart = Math.max(workHours.start, rawStart);
      const hourEnd = Math.min(workHours.end, end);
      if (hourEnd <= hourStart) return null;
      // A range wholly inside a break has nothing to predict.
      if (breaks.some((b) => b.start <= hourStart * 60 && b.end >= hourEnd * 60)) return null;
      // The moments are checked against the CLAMPED range, not the one the model
      // asked for: a phase trimmed from 8-10 to 9-10 must not keep an 8:40
      // moment that is now outside its own card.
      const moments = sanitizeMoments(w.moments, {
        workHours, breaks, from: hourStart * 60, to: hourEnd * 60,
      });
      // A phase with no usable moment has nothing to show but its own title.
      if (moments.length === 0) return null;
      return {
        predictedHourStart: hourStart,
        predictedHourEnd: hourEnd,
        confidence: Math.min(1, Math.max(0, Number(w.confidence) || 0)),
        rationale: String(w.rationale || '').trim().slice(0, MAX_RATIONALE),
        moments,
      };
    })
    .filter(Boolean)
    // Two windows on the same hour would render as two cards for one range.
    // Sorted by confidence first, so the one that survives is the stronger.
    .sort((a, b) => b.confidence - a.confidence)
    .filter((w) => {
      if (seen.has(w.predictedHourStart)) return false;
      seen.add(w.predictedHourStart);
      return true;
    })
    .slice(0, max)
    .sort((a, b) => a.predictedHourStart - b.predictedHourStart);
}

// Called once a day by the cron job (see routes/cron.js), never from a request
// path — so no caching here. Never throws. Returns one of:
//
//   { windows, wildcards }  success: sanitized phases, their moments, and the
//                           low-probability minutes between them
//   null                the feature is off: no API key configured
//   { error: '...' }    the call was made and it failed
//
// The last two used to be the same answer, null, and the cron reported both as
// ok: true — so a deploy where every single Gemini call was rejected looked
// exactly like a deploy with the feature deliberately switched off.
async function getSmartWindows({ sightingTimestamps, heatmap, total, workHours, breaks, timeZone, maxWindows = 3, model }) {
  if (!process.env.GEMINI_API_KEY) return null;

  // Supplied by the caller, which is where the settings live; resolved once
  // there and reused across the retry, so a model swap mid-run cannot produce
  // two attempts answered by two different models.
  if (!isValidModel(model)) return { error: `no usable model configured (${model})` };

  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    // A controller per attempt: an aborted one stays aborted, so reusing it
    // would make the retry fail instantly with the first attempt's error.
    const answer = await attemptSmartWindows({
      sightingTimestamps, heatmap, total, workHours, breaks, timeZone, maxWindows, model,
    });
    if (!answer.error) return answer;
    last = answer;
    if (attempt < ATTEMPTS) {
      console.warn(`[gemini] attempt ${attempt} of ${ATTEMPTS} failed (${answer.error}) — retrying.`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  console.error('[gemini] smart windows unavailable, falling back to statistical model:', last.error);
  return last;
}

// One attempt. Never throws; returns { windows, wildcards } or { error }.
async function attemptSmartWindows({ sightingTimestamps, heatmap, total, workHours, breaks, timeZone, maxWindows, model }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const prompt = buildPrompt({
      sightingTimestamps: sightingTimestamps.slice(0, MAX_SIGHTINGS_SENT),
      heatmap,
      total,
      workHours,
      breaks,
      timeZone: timeZone || 'UTC',
      maxWindows,
    });
    const res = await fetch(`${endpointFor(model)}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          // A LOW budget, not zero.
          //
          // This was `thinkingBudget: 0` — structured classification does not
          // need extended reasoning, so why pay for it. But the 3.x flash
          // models cannot have thinking turned off, and they reject a budget of
          // 0 with a bare HTTP 400, "Request contains an invalid argument",
          // naming no field. So every call failed. And because a failed call
          // falls back to the statistical model on purpose, the page kept
          // working and nothing surfaced: the AI refinement had never once run
          // on any deploy.
          //
          // Leaving thinkingConfig off entirely is valid but slow: measured
          // against this exact prompt, the model's own default took 9.1-9.8s,
          // over the 8s timeout this used to have. A budget of 128 returns the
          // same windows in 4.6-5.1s. Low enough to keep the original intent,
          // non-zero so the model will accept it.
          thinkingConfig: { thinkingBudget: 128 },
        },
      }),
    });
    // The body is where the reason lives. Keeping only the status turned a
    // named, fixable rejection into "Gemini responded 400" — a message that
    // cost an afternoon of bisecting the request to get back.
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let reason = detail.slice(0, 300);
      try { reason = JSON.parse(detail).error?.message || reason; } catch (e) { /* keep raw */ }
      throw new Error(`Gemini responded ${res.status}: ${reason}`);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.windows) || parsed.windows.length === 0) throw new Error('malformed windows response');

    const windows = sanitizeWindows(parsed.windows, { workHours, breaks, max: maxWindows });
    if (windows.length === 0) throw new Error('no window survived the office rules');
    if (windows.length !== parsed.windows.length) {
      console.warn(`[gemini] kept ${windows.length} of ${parsed.windows.length} windows `
        + '— the rest fell outside work hours, sat on a break, kept no usable moment, '
        + 'or duplicated another.');
    }
    const wildcards = sanitizeWildcards(parsed.wildcards, { workHours, breaks, windows });
    const moments = windows.reduce((n, w) => n + w.moments.length, 0);
    console.log(`[gemini] ${model}: ${windows.length} phases, ${moments} moments, `
      + `${wildcards.length} wildcards.`);
    // The model is reported alongside the answer so the cron can store it and
    // the dashboard can say which one actually produced what is on screen.
    return { windows, wildcards, model };
  } catch (e) {
    // Reported, not logged as final: getSmartWindows decides whether this was
    // the last word or just the first attempt.
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getSmartWindows, sanitizeWindows, sanitizeWildcards, sanitizeMoments, buildPrompt,
  listModels, endpointFor, MOMENT_TIERS, API_HOST,
  isValidModel, MODEL_PATTERN, RECOMMENDED_MODELS,
};
