/**
 * The Gemini-refined prediction: which hour ranges of the day HR tends to roam.
 *
 * WHAT IT IS ASKED FOR, AND WHAT IT IS NOT. The model picks RANGES — the day's
 * phases — and nothing finer. Everything inside a range is computed from the
 * data by routes/sightings.js: the sure/likely/maybe moments come from ranking
 * the quarter-hours of that range by how many sightings landed in each, and the
 * wildcard is projected into the gap after it from the median gap between
 * sightings. A model guessing at a minute would be inventing precision it has no
 * basis for, and a model assigning the tiers would be re-deciding something the
 * data already answers.
 *
 * So the prompt tells it the office's rules — work hours, work days, break times
 * — and asks for ranges that respect them. It also explains what happens to its
 * answer downstream, because "return ranges with gaps between them" only makes
 * sense once you know a wildcard goes in those gaps.
 *
 * And then sanitizeWindows enforces the same rules on the way back, because a
 * model told to stay inside 9-18 will occasionally hand back 8-9 anyway. The
 * prompt is a request; the sanitizer is the guarantee.
 */

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TIMEOUT_MS = 8000;
const MAX_SIGHTINGS_SENT = 500;
const MAX_RATIONALE = 200;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// No `tier` here any more. It used to rank the three windows against each other,
// which is what made the confidence labels read as four rival categories; they
// are moments inside a single range now, and the range's own strength is what
// `confidence` is for.
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
        },
        required: ['predictedHourStart', 'predictedHourEnd', 'confidence', 'rationale'],
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

    + `Rules, all of which are hard requirements:\n`
    + `1. Every phase must lie entirely within work hours (${workHours.start}:00-${workHours.end}:00).\n`
    + `2. No phase may sit inside a break time. HR is not roaming the desks during `
    + `lunch, so sightings logged then say nothing about the pattern — weight them at zero.\n`
    + `3. Phases must not overlap each other, and should not be adjacent: leave at least `
    + `an hour of gap between one phase ending and the next beginning.\n`
    + `4. Base the pattern on time-of-day clustering across work days only. Ignore rows `
    + `for non-work days in the heatmap entirely. Weight recent sightings more heavily `
    + `than old ones.\n`
    + `5. Fewer, stronger phases beat ${maxWindows} weak ones. Return only the ranges the `
    + `data actually supports.\n\n`

    + `WHAT HAPPENS TO YOUR ANSWER\n`
    + `Do not predict a specific minute — the exact times are computed from the data, not `
    + `from you. Each range you return is subdivided automatically: its quarter-hours are `
    + `ranked by how many sightings fell in each, and the top three become the "sure", `
    + `"likely" and "maybe" moments inside that range. A fourth "wildcard" moment is then `
    + `projected into the GAP AFTER each phase, which is why rule 3 asks you to leave one.\n\n`

    + `confidence is how consistently that range actually recurs — do not inflate it. `
    + `rationale is one short, plain-language sentence about that range, for a `
    + `non-technical reader to enjoy; write about the range, not about the whole day.`;
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
      // A range wholly inside a break has nothing to predict; the quarter-hour
      // ranking downstream would return no moments for it anyway.
      if (breaks.some((b) => b.start <= hourStart * 60 && b.end >= hourEnd * 60)) return null;
      return {
        predictedHourStart: hourStart,
        predictedHourEnd: hourEnd,
        confidence: Math.min(1, Math.max(0, Number(w.confidence) || 0)),
        rationale: String(w.rationale || '').trim().slice(0, MAX_RATIONALE),
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
// path — so no caching here. Returns { windows: [...] } of sanitized ranges, or
// null if the feature is disabled (no API key), the call fails for any reason,
// or nothing survived sanitizing. Never throws.
async function getSmartWindows({ sightingTimestamps, heatmap, total, workHours, breaks, timeZone, maxWindows = 3 }) {
  if (!process.env.GEMINI_API_KEY) return null;

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
    const res = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          // Structured classification, not a task that benefits from extended
          // reasoning — skip "thinking" tokens to keep latency and cost down.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini responded ${res.status}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.windows) || parsed.windows.length === 0) throw new Error('malformed windows response');

    const windows = sanitizeWindows(parsed.windows, { workHours, breaks, max: maxWindows });
    if (windows.length === 0) throw new Error('no window survived the office rules');
    if (windows.length !== parsed.windows.length) {
      console.warn(`[gemini] kept ${windows.length} of ${parsed.windows.length} windows `
        + '— the rest fell outside work hours, sat on a break, or duplicated another.');
    }
    return { windows };
  } catch (e) {
    console.error('[gemini] smart windows unavailable, falling back to statistical model:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getSmartWindows, sanitizeWindows, buildPrompt };
