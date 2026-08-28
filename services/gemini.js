const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TIMEOUT_MS = 8000;
const MAX_SIGHTINGS_SENT = 500;
const TIERS = ['sure', 'likely', 'maybe'];

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    windows: {
      type: 'array',
      description: 'Exactly 3 candidate windows, ranked most to least confident: sure, likely, maybe.',
      items: {
        type: 'object',
        properties: {
          tier: { type: 'string', enum: TIERS },
          predictedHourStart: { type: 'integer', description: '0-23, local hour' },
          predictedHourEnd: { type: 'integer', description: '0-23, local hour, window end' },
          confidence: { type: 'number', description: '0 to 1' },
          rationale: { type: 'string', description: 'One short sentence, plain language' },
        },
        required: ['tier', 'predictedHourStart', 'predictedHourEnd', 'confidence', 'rationale'],
      },
    },
  },
  required: ['windows'],
};

function buildPrompt({ sightingTimestamps, heatmap, total }) {
  return `You are analyzing timestamps of sightings of an office HR person roaming past ` +
    `coworkers' desks, logged by a team for fun. Unix timestamps (seconds) of the most ` +
    `recent sightings, newest first:\n${JSON.stringify(sightingTimestamps)}\n\n` +
    `Aggregate day-of-week x hour-of-day counts (heatmap[day][hour], day 0=Sunday):\n` +
    `${JSON.stringify(heatmap)}\n\nTotal sightings: ${total}.\n\n` +
    `Identify the recurring daily time-of-day windows this person tends to roam (weight ` +
    `recent sightings more heavily than old ones; look for day-part clustering rather than ` +
    `a flat count). Return exactly 3 candidate windows for the NEXT roam, ranked most to ` +
    `least confident and tagged "sure", "likely", "maybe": "sure" is the window you're most ` +
    `confident recurs, "maybe" is a plausible but weaker pattern. Confidence should reflect ` +
    `how consistent each pattern actually is (don't inflate it), and each rationale should be ` +
    `one short, plain-language sentence a non-technical reader would enjoy.`;
}

// Called once per logged sighting from /admin (see routes/sightings.js), never
// from a poll loop — so no caching here. Returns { windows: [...] } (3 tiers) or
// null if the feature is disabled (no API key) or the call fails for any
// reason. Never throws.
async function getSmartWindows({ sightingTimestamps, heatmap, total }) {
  if (!process.env.GEMINI_API_KEY) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const prompt = buildPrompt({
      sightingTimestamps: sightingTimestamps.slice(0, MAX_SIGHTINGS_SENT),
      heatmap,
      total,
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
    return { windows: parsed.windows };
  } catch (e) {
    console.error('[gemini] smart windows unavailable, falling back to statistical model:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getSmartWindows, TIERS };
