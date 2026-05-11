// Pass-2 layer: write a one-line operator-friendly rationale per top search
// result, using the server-computed numbers as facts (the LLM is NOT asked to
// price anything — pricing already happened in searchExecutor). Output is
// trust-bounded to the input data, so a hallucinated price can't reach the UI.
//
// Also hosts generateLookupAnswer — the Q&A path's answer composer, which
// takes the partner+topic data the executor pulled and turns it into a 1–3
// sentence operator answer.

const RATIONALE_MODEL = 'claude-haiku-4-5';
const MAX_RESULTS_FOR_RATIONALE = 3;
const LOOKUP_MODEL = 'claude-haiku-4-5';

const SYSTEM_PROMPT = `You write one-line rationales for travel partner search results.

The operator already sees the partner name, price, and metadata in the UI. Your job: in 22 words or fewer, explain WHY this result fits the query — or flag the caveat — citing the specific facts provided.

Rules:
- One sentence per result. Plain prose. No markdown, no emojis, no headings.
- Cite concrete data from the input: amounts, currencies, child ages, meal plans, rate-list names, day counts. Round currency amounts to whole numbers.
- Lead with the caveat when one is present:
    flags.blockingCondition → start with "Blocking condition —"
    flags.extractionConfidence='low' → start with "Verify rates —"
    flags.imagesMissing → mention "no images on file" once
    warnings non-empty → reference the first warning's gist
- For computedPrice.pricingMode='perPersonEstimate' (no dates given): say "From <amount> per person sharing on <rateListName>; add dates for a real total."
- Do NOT invent locations, prices, amenities, or features absent from the input.
- Do NOT use generic phrases: "great option", "perfect for", "ideal", "unforgettable", "amazing", "stunning".
- Do NOT repeat the partner name (the UI shows it).

Return ONLY this JSON shape, nothing else:
{ "rationales": [{ "id": "<exact id from input>", "rationale": "<one sentence>" }] }`;

// Strip a result down to the fields the LLM actually needs. Keeps token cost
// low and removes anything that could leak data we don't want it to see (like
// internal Mongo ids beyond the shortened id, full image URLs, etc.).
function compactResult(r) {
  const cp = r.computedPrice || {};
  const out = {
    id: String(r.id),
    type: r.type,
    destination: r.destination || null,
  };

  if (r.type === 'hotel') {
    out.hotelType = r.hotelType;
    out.stars = r.stars || null;
    out.mealPlan = r.mealPlan || null;
    out.rateListName = r.rateListName || null;
    out.roomType = r.roomType || null;
    out.inclusions = (r.inclusions || []).slice(0, 4);
    out.exclusions = (r.exclusions || []).slice(0, 4);
  } else if (r.type === 'activity') {
    out.duration = r.duration || null;
    out.season = r.season || null;
  } else if (r.type === 'transport') {
    out.transportType = r.transportType;
    out.capacity = r.capacity || null;
    out.routeOrZone = r.routeOrZone || null;
  } else if (r.type === 'package') {
    out.durationNights = r.durationNights || null;
    out.pricingListName = r.pricingListName || null;
    out.mealPlan = r.mealPlan || null;
    out.inclusions = (r.inclusions || []).slice(0, 4);
  }

  out.computedPrice = {
    pricingMode: cp.pricingMode,
    currency: cp.currency,
    sourceCurrency: cp.sourceCurrency,
    total: cp.total != null ? Math.round(cp.total) : null,
    perNight: cp.perNight != null ? Math.round(cp.perNight) : null,
    perPerson: cp.perPerson != null ? Math.round(cp.perPerson) : null,
    nights: cp.nights ?? null,
    days: cp.days ?? null,
  };

  // Only forward flags that are actually true / relevant — keeps the prompt small.
  const f = r.flags || {};
  out.flags = {};
  for (const k of [
    'noDatesGiven', 'paxAssumed', 'childAgeAssumed', 'childRateApplied',
    'blockingCondition', 'imagesMissing', 'minAgeViolation',
    'groupSizeExceeded', 'capacityExceeded', 'noPaxGiven', 'noDaysGiven',
    'paxTierFallback', 'childRebateNotApplied',
  ]) {
    if (f[k]) out.flags[k] = true;
  }
  if (f.extractionConfidence && f.extractionConfidence !== 'high') {
    out.flags.extractionConfidence = f.extractionConfidence;
  }

  if (r.warnings?.length) out.firstWarning = r.warnings[0];

  return out;
}

function compactParsed(parsed) {
  if (!parsed) return null;
  return {
    type: parsed.type,
    destinationName: parsed.destinationName,
    dateRange: parsed.dateRange,
    adults: parsed.adults,
    children: parsed.children,
    budgetMax: parsed.budgetMax,
    currency: parsed.currency,
    boardBasis: parsed.boardBasis,
    mustHave: parsed.mustHave,
  };
}

function extractJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed); } catch (_) { /* fall through */ }
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++;
    else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

/**
 * Generate one-line rationales for the top results.
 * Returns { rationales, usage } — `rationales` is `[{ id, rationale }]`,
 * empty if nothing could be generated. Caller is responsible for charging.
 */
export async function generateRationales({ query, parsed, results }) {
  if (!Array.isArray(results) || results.length === 0) {
    return { rationales: [], usage: null };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const top = results.slice(0, MAX_RESULTS_FOR_RATIONALE).map(compactResult);
  const userMessage =
    `Operator query: "${(query || '').slice(0, 300)}"\n\n` +
    `Parsed slots:\n${JSON.stringify(compactParsed(parsed), null, 2)}\n\n` +
    `Top results:\n${JSON.stringify(top, null, 2)}\n\n` +
    `Write one rationale per result. Match ids exactly.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: RATIONALE_MODEL,
      max_tokens: 500,
      // Cache the (long) system prompt so subsequent rationale calls within
      // the 5-min window cost ~10% on input. Same trick as the parser.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  const u = data.usage || {};
  const usage = {
    model: RATIONALE_MODEL,
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadInputTokens: u.cache_read_input_tokens || 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
  };

  const raw = extractJson(text);
  // Validate the model returned ids that match what we sent — drop anything
  // that doesn't (the LLM occasionally hallucinates ids; we don't want a
  // mismatched rationale floating against the wrong card).
  const validIds = new Set(top.map(r => r.id));
  const rationales = Array.isArray(raw?.rationales)
    ? raw.rationales
        .filter(r => r && validIds.has(String(r.id)) && typeof r.rationale === 'string')
        .map(r => ({ id: String(r.id), rationale: r.rationale.trim().slice(0, 280) }))
    : [];

  return { rationales, usage };
}

// ─── LOOKUP ANSWER (Q&A intent) ───────────────────────────────────────────────

const LOOKUP_SYSTEM_PROMPT = `You answer one travel-operator question about ONE specific partner using ONLY the data provided.

Rules:
- 1–3 sentences. Plain prose. No markdown, no headings, no emojis.
- Cite specific data: amounts, currencies, day counts, percentages, named tiers/seasons. Round currency amounts to whole numbers.
- If a topic is requested but the data is missing or empty (e.g. cancellation tiers array is empty), say so plainly: "No cancellation policy is recorded for this hotel — the rate list doesn't define one." Don't fabricate one.
- Don't repeat the partner name (the UI already shows it).
- Don't add generic recommendations or sales language ("a great option", "perfect for").
- For cancellation_policy: list the tier breakpoints in order (e.g. "30+ days: 25%, 14–29 days: 50%, <14 days: 100%"). Mention the deposit requirement once if non-zero.
- For inclusions/exclusions: list the items as a comma-separated phrase, naming the meal plan once.
- For fees: name each pass-through fee with its unit ("Mara Reserve Fee — per person per day, USD 100 nonResident").
- For child_policy: summarize the dominant pattern across brackets — don't dump every season.
- For rates/general: keep to the most useful 1–2 facts.

Return ONLY this JSON: { "answer": "<one to three sentences>" }`;

/**
 * Generate a one-paragraph answer to a Q&A query using the lookup payload the
 * executor produced. Returns { answer, usage }. Throws on API errors so the
 * route can fall back to a structured-only response.
 */
export async function generateLookupAnswer({ query, parsed, lookup }) {
  if (!lookup) return { answer: null, usage: null };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const userMessage =
    `Operator question: "${(query || '').slice(0, 300)}"\n\n` +
    `Topic: ${lookup.topic}\n` +
    `Partner kind: ${lookup.kind}\n` +
    `Partner name: ${lookup.name}\n` +
    `Destination: ${lookup.destination || '—'}\n\n` +
    `Topic data:\n${JSON.stringify(lookup, null, 2)}\n\n` +
    `Write the answer.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: LOOKUP_MODEL,
      max_tokens: 350,
      system: [{ type: 'text', text: LOOKUP_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  const u = data.usage || {};
  const usage = {
    model: LOOKUP_MODEL,
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadInputTokens: u.cache_read_input_tokens || 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
  };

  const raw = extractJson(text);
  const answer = (raw && typeof raw.answer === 'string') ? raw.answer.trim().slice(0, 600) : null;
  return { answer, usage };
}
