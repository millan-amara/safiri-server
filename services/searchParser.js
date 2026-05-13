// Natural-language query parser for /api/search.
//
// Takes a free-form operator question — "hotel for 2 adults and 1 kid in Maasai
// Mara July budget 50k" — and returns a strict structured spec the executor can
// run against the org's partner inventory. Uses Claude Haiku with a cached
// system prompt; cost is ~1 AI credit per call.
//
// We deliberately don't price or rank here — that's executeSearch's job. This
// step is *only* slot-filling. Confidence scores per slot let the route ask
// for clarification when the operator's prompt was ambiguous instead of
// guessing dates / pax / budget.

const PARSER_MODEL = 'claude-haiku-4-5';

// Hand-built so the model can't drift. Every field has a default the executor
// treats as "not specified" — null for scalars, [] for arrays, {} for objects.
const EMPTY_PARSED = {
  intent: 'search',           // 'search' (find me X) | 'lookup' (tell me about X) | 'diagnostic' (audit my inventory)
  type: null,                 // 'hotel' | 'activity' | 'transport' | 'package' | null
  destinationName: null,      // free text — executor fuzzy-matches against Destination + partner.destination
  propertyType: null,         // null = any property; otherwise subset of Hotel.type enum to narrow to (e.g. ['tented_camp', 'conservancy_camp'])
  subjectName: null,          // partner name when intent='lookup' ("Serena", "Mara Serena Lodge")
  lookupTopic: null,          // when intent='lookup': 'cancellation_policy' | 'child_policy' | 'inclusions' | 'exclusions' | 'fees' | 'rates' | 'rooms' | 'amenities' | 'general'
  diagnostic: null,           // when intent='diagnostic': 'missing_rate_lists' | 'expiring_rate_lists' | 'expired_rate_lists' | 'missing_images' | 'low_confidence_rates' | 'blocking_conditions'
  dateRange: { from: null, to: null },   // ISO yyyy-mm-dd; either side can be null
  adults: null,               // integer
  children: [],               // [{ age: number }]; if ages unknown, [{ age: null }] × count
  budgetMax: null,            // number in `currency`
  currency: null,             // ISO code, e.g. 'USD', 'KES'
  boardBasis: null,           // 'RO' | 'BB' | 'HB' | 'FB' | 'AI' | null
  clientType: null,           // 'retail' | 'contract' | 'resident' — drives rate-list audience filter
  nationality: null,          // 'citizen' | 'resident' | 'nonResident' — drives park-fee tier
  mustHave: [],               // free-text qualitative requirements ("pool", "kid friendly")
  niceToHave: [],
  confidence: {},             // map of fieldName → 0..1
};

function buildSystemPrompt(today) {
  return `You parse a travel operator's natural-language partner-search query into strict JSON.

Today is ${today}. Resolve relative dates ("July", "next month", "Easter") to absolute ISO yyyy-mm-dd values relative to today. If a year is omitted, prefer the next future occurrence.

Return ONLY a JSON object with this exact shape — no markdown, no commentary:

{
  "intent": "search" | "lookup" | "diagnostic",
  "type": "hotel" | "activity" | "transport" | "package" | null,
  "destinationName": string | null,
  "propertyType": ["hotel" | "lodge" | "tented_camp" | "resort" | "villa" | "apartment" | "guesthouse" | "conservancy_camp"] | null,
  "subjectName": string | null,
  "lookupTopic": "cancellation_policy" | "child_policy" | "inclusions" | "exclusions" | "fees" | "rates" | "rooms" | "amenities" | "general" | null,
  "diagnostic": "missing_rate_lists" | "expiring_rate_lists" | "expired_rate_lists" | "missing_images" | "low_confidence_rates" | "blocking_conditions" | null,
  "dateRange": { "from": "YYYY-MM-DD" | null, "to": "YYYY-MM-DD" | null },
  "adults": integer | null,
  "children": [{ "age": integer | null }],
  "budgetMax": number | null,
  "currency": "USD" | "KES" | "EUR" | "GBP" | "TZS" | "UGX" | "ZAR" | null,
  "boardBasis": "RO" | "BB" | "HB" | "FB" | "AI" | null,
  "clientType": "retail" | "contract" | "resident" | null,
  "nationality": "citizen" | "resident" | "nonResident" | null,
  "mustHave": [string],
  "niceToHave": [string],
  "confidence": { "intent": 0..1, "type": 0..1, "destinationName": 0..1, "propertyType": 0..1, "subjectName": 0..1, "lookupTopic": 0..1, "dateRange": 0..1, "adults": 0..1, "children": 0..1, "budgetMax": 0..1, "clientType": 0..1, "nationality": 0..1 }
}

Rules:
- "intent":
    "lookup" when the operator is asking ABOUT a specific named partner ("What's the cancellation policy for Serena?", "Does Mara Serena include park fees?", "Tell me about Aldiana").
    "diagnostic" when the operator is auditing their inventory for missing/stale/expiring data ("hotels missing rate lists", "rate lists expiring this month", "hotels without images", "what needs cleaning up").
    "search" when they're trying to find or filter inventory ("hotel in Mara", "tented camp under $200"). When in doubt, default to "search".
- "diagnostic": only set when intent="diagnostic". Map the query to the closest sub-type:
    "missing rate lists" / "no prices" / "missing pricing" / "haven't priced" → "missing_rate_lists"
    "expiring" / "about to expire" / "running out" / "rate lists this month" → "expiring_rate_lists"
    "expired" / "past validity" / "out of date" → "expired_rate_lists"
    "no images" / "missing photos" / "without images" → "missing_images"
    "low confidence" / "verify rates" / "uncertain rates" / "needs review" → "low_confidence_rates"
    "blocking conditions" / "unacknowledged conditions" / "unresolved warnings" → "blocking_conditions"
  Leave NULL for non-diagnostic intent.
- "subjectName": only populated when intent="lookup". The exact partner name the operator named (e.g. "Serena", "Mara Serena Lodge", "Aldiana Kwanza"). NULL for search intent.
- "lookupTopic": only populated when intent="lookup". Map the question to the closest topic: cancellation/refund → "cancellation_policy"; child rate/kids policy → "child_policy"; what's included/in the rate → "inclusions"; what's excluded/extras → "exclusions"; park fees/conservancy fees/levies → "fees"; price/per-night/rates → "rates"; room types/suites → "rooms"; pool/wifi/spa → "amenities"; otherwise "general". NULL for search intent.
- For lookup intent, leave dateRange/adults/children/budgetMax/etc. NULL — those are search slots.
- Use null when the operator did not specify a value. NEVER guess dates, pax, or budget — leave them null with confidence 0.
- "type": infer from context. Hotel/lodge/camp/resort/where to stay → "hotel". Game drive/walk/excursion → "activity". Transfer/4x4/van/flight → "transport". Multi-day combo/package/trail → "package". When the query mentions a specific lodging concept first, prefer "hotel".
- "propertyType": narrows search to specific Hotel.type values. NULL means "any kind of property". The mapping:
    "hotel" / "place to stay" / "accommodation" → null (operator means ANY property, don't narrow)
    "lodge" / "lodges" → ["lodge"]
    "tented camp" / "tented camps" → ["tented_camp"]
    "conservancy camp" → ["conservancy_camp"]
    "camp" / "camps" (no qualifier) → ["tented_camp", "conservancy_camp"]
    "resort" / "resorts" → ["resort"]
    "villa" / "villas" → ["villa"]
    "apartment" / "apartments" / "flat" → ["apartment"]
    "guesthouse" / "B&B" (when used as a property type, not as a meal plan) → ["guesthouse"]
  If multiple specific types are mentioned ("lodge or villa"), include both. If "hotel" appears with another type ("hotel or lodge"), prefer null since "hotel" is the catch-all. NEVER put property-type words in mustHave — they have their own field.
- "children": one entry per child. If the operator says "1 kid" without an age, return [{ "age": null }]. If "2 kids ages 5 and 9", return [{ "age": 5 }, { "age": 9 }]. If they say "for a family" / "for families" without an explicit count, infer 2 adults + 2 children with ages null (so the executor can apply default child rates and flag the assumption).
- "budgetMax": parse "50k" as 50000, "1.2m" as 1200000. If the operator writes "USD 500" or "$500" → currency "USD" budgetMax 500. If "KES 50,000" or "50k KES" or "Ksh 50000" → currency "KES" budgetMax 50000. If just a bare number with no currency, leave currency null.
- "boardBasis": "full board" → FB, "half board" → HB, "bed and breakfast" or "B&B" → BB, "all inclusive" → AI, "room only" → RO.
- "clientType": who's buying — selects which audience-tagged rate list applies. "retail/public/rack/walk-in/direct" → "retail". "contract/DMC/agent/trade/STO/tour operator" → "contract". "resident/EAC/East African" rates (priced for someone living locally) → "resident". Leave null if the operator didn't say.
- "nationality": traveler nationality — selects park-fee/visa-fee tier. "citizen/Kenyan/Tanzanian/local" → "citizen". "resident/expat/work-permit holder" → "resident". "non-resident/foreigner/international/overseas" → "nonResident". Note: "resident" can mean either clientType or nationality — set both if the operator clearly means resident-priced AND resident traveler; otherwise pick the one that fits context. Leave null if the operator didn't say.
- "mustHave"/"niceToHave": short literal qualitative cues from the query ("pool", "tented", "luxury", "honeymoon"). Don't invent — only include what the operator wrote. Don't put clientType/nationality words here; they have their own fields. Don't put property-type words ("hotel", "lodge", "camp", "villa", etc.) here — those go in propertyType. Don't put sort or ranking words here either: "cheapest", "best", "lowest priced", "most affordable", "top", "highest rated", "most expensive", "biggest", "newest" are sort cues, not filter cues — the executor already sorts cheapest-first by default, so leave them out and the operator still gets what they wanted.
- "confidence": 1.0 when the operator's intent is unambiguous, 0.5 when partly inferred (e.g. you assumed the year), 0.0 when the field is null because the operator didn't say. Always include all confidence keys listed in the schema.

Examples:

Query: "hotel for 2 adults and 1 kid in Maasai Mara July budget 50k USD"
{
  "intent": "search",
  "type": "hotel",
  "destinationName": "Maasai Mara",
  "propertyType": null,
  "subjectName": null,
  "lookupTopic": null,
  "dateRange": { "from": "${today.slice(0,4)}-07-01", "to": "${today.slice(0,4)}-07-31" },
  "adults": 2,
  "children": [{ "age": null }],
  "budgetMax": 50000,
  "currency": "USD",
  "boardBasis": null,
  "clientType": null,
  "nationality": null,
  "mustHave": [],
  "niceToHave": [],
  "confidence": { "intent": 1, "type": 1, "destinationName": 1, "propertyType": 1, "subjectName": 0, "lookupTopic": 0, "dateRange": 0.5, "adults": 1, "children": 0.7, "budgetMax": 1, "clientType": 0, "nationality": 0 }
}

Query: "tented camp in Mara"
{
  "intent": "search",
  "type": "hotel",
  "destinationName": "Mara",
  "propertyType": ["tented_camp"],
  "subjectName": null,
  "lookupTopic": null,
  "dateRange": { "from": null, "to": null },
  "adults": null,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": null,
  "nationality": null,
  "mustHave": [],
  "niceToHave": [],
  "confidence": { "intent": 1, "type": 1, "destinationName": 0.8, "propertyType": 1, "subjectName": 0, "lookupTopic": 0, "dateRange": 0, "adults": 0, "children": 0, "budgetMax": 0, "clientType": 0, "nationality": 0 }
}

Query: "cheapest hotel in Mara"
{
  "intent": "search",
  "type": "hotel",
  "destinationName": "Mara",
  "propertyType": null,
  "subjectName": null,
  "lookupTopic": null,
  "dateRange": { "from": null, "to": null },
  "adults": null,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": null,
  "nationality": null,
  "mustHave": [],
  "niceToHave": [],
  "confidence": { "intent": 1, "type": 1, "destinationName": 0.9, "propertyType": 1, "subjectName": 0, "lookupTopic": 0, "dateRange": 0, "adults": 0, "children": 0, "budgetMax": 0, "clientType": 0, "nationality": 0 }
}

Query: "luxury lodge or villa in Diani"
{
  "intent": "search",
  "type": "hotel",
  "destinationName": "Diani",
  "propertyType": ["lodge", "villa"],
  "subjectName": null,
  "lookupTopic": null,
  "dateRange": { "from": null, "to": null },
  "adults": null,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": null,
  "nationality": null,
  "mustHave": ["luxury"],
  "niceToHave": [],
  "confidence": { "intent": 1, "type": 1, "destinationName": 1, "propertyType": 1, "subjectName": 0, "lookupTopic": 0, "dateRange": 0, "adults": 0, "children": 0, "budgetMax": 0, "clientType": 0, "nationality": 0 }
}

Query: "Zanzibar lodge for a family in July, resident rates"
{
  "intent": "search",
  "type": "hotel",
  "destinationName": "Zanzibar",
  "propertyType": ["lodge"],
  "subjectName": null,
  "lookupTopic": null,
  "dateRange": { "from": "${today.slice(0,4)}-07-01", "to": "${today.slice(0,4)}-07-31" },
  "adults": 2,
  "children": [{ "age": null }, { "age": null }],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": "resident",
  "nationality": null,
  "mustHave": [],
  "niceToHave": [],
  "confidence": { "intent": 1, "type": 1, "destinationName": 1, "propertyType": 1, "subjectName": 0, "lookupTopic": 0, "dateRange": 0.5, "adults": 0.6, "children": 0.6, "budgetMax": 0, "clientType": 1, "nationality": 0 }
}

Query: "lodge in Maasai Mara contract rate for 2 Kenyan citizens"
{
  "intent": "search",
  "type": "hotel",
  "destinationName": "Maasai Mara",
  "propertyType": ["lodge"],
  "subjectName": null,
  "lookupTopic": null,
  "dateRange": { "from": null, "to": null },
  "adults": 2,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": "contract",
  "nationality": "citizen",
  "mustHave": [],
  "niceToHave": [],
  "confidence": { "intent": 1, "type": 1, "destinationName": 1, "propertyType": 1, "subjectName": 0, "lookupTopic": 0, "dateRange": 0, "adults": 1, "children": 0, "budgetMax": 0, "clientType": 1, "nationality": 1 }
}

Query: "What's the cancellation policy for Serena?"
{
  "intent": "lookup",
  "type": "hotel",
  "destinationName": null,
  "propertyType": null,
  "subjectName": "Serena",
  "lookupTopic": "cancellation_policy",
  "dateRange": { "from": null, "to": null },
  "adults": null,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": null,
  "nationality": null,
  "mustHave": [],
  "niceToHave": [],
  "confidence": { "intent": 1, "type": 0.7, "destinationName": 0, "propertyType": 0, "subjectName": 1, "lookupTopic": 1, "dateRange": 0, "adults": 0, "children": 0, "budgetMax": 0, "clientType": 0, "nationality": 0 }
}

Query: "Does Mara Serena include park fees?"
{
  "intent": "lookup",
  "type": "hotel",
  "destinationName": null,
  "propertyType": null,
  "subjectName": "Mara Serena",
  "lookupTopic": "fees",
  "dateRange": { "from": null, "to": null },
  "adults": null,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": null,
  "nationality": null,
  "mustHave": [],
  "niceToHave": [],
  "confidence": { "intent": 1, "type": 0.8, "destinationName": 0, "propertyType": 0, "subjectName": 1, "lookupTopic": 1, "dateRange": 0, "adults": 0, "children": 0, "budgetMax": 0, "clientType": 0, "nationality": 0 }
}

Query: "hotels missing rate lists in Mara"
{
  "intent": "diagnostic",
  "type": "hotel",
  "destinationName": "Mara",
  "propertyType": null,
  "subjectName": null,
  "lookupTopic": null,
  "diagnostic": "missing_rate_lists",
  "dateRange": { "from": null, "to": null },
  "adults": null,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": null,
  "nationality": null,
  "mustHave": [],
  "niceToHave": [],
  "confidence": { "intent": 1, "type": 1, "destinationName": 1, "propertyType": 0, "subjectName": 0, "lookupTopic": 0, "dateRange": 0, "adults": 0, "children": 0, "budgetMax": 0, "clientType": 0, "nationality": 0 }
}

Query: "rate lists expiring this month"
{
  "intent": "diagnostic",
  "type": "hotel",
  "destinationName": null,
  "propertyType": null,
  "subjectName": null,
  "lookupTopic": null,
  "diagnostic": "expiring_rate_lists",
  "dateRange": { "from": null, "to": null },
  "adults": null,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": null,
  "nationality": null,
  "mustHave": [],
  "niceToHave": [],
  "confidence": { "intent": 1, "type": 0.7, "destinationName": 0, "propertyType": 0, "subjectName": 0, "lookupTopic": 0, "dateRange": 0, "adults": 0, "children": 0, "budgetMax": 0, "clientType": 0, "nationality": 0 }
}`;
}

// Strip markdown fences if the model ignored the rule. Then JSON.parse. If the
// model returned trailing prose, take the first balanced JSON object.
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

// Coerce model output back into the canonical shape — guards against the model
// dropping fields or returning slightly-wrong types under load.
const VALID_LOOKUP_TOPICS = [
  'cancellation_policy', 'child_policy', 'inclusions', 'exclusions',
  'fees', 'rates', 'rooms', 'amenities', 'general',
];

const VALID_PROPERTY_TYPES = [
  'hotel', 'lodge', 'tented_camp', 'resort', 'villa', 'apartment', 'guesthouse', 'conservancy_camp',
];

const VALID_DIAGNOSTICS = [
  'missing_rate_lists', 'expiring_rate_lists', 'expired_rate_lists',
  'missing_images', 'low_confidence_rates', 'blocking_conditions',
];

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PARSED };
  const out = { ...EMPTY_PARSED, confidence: {} };

  if (['lookup', 'diagnostic'].includes(raw.intent)) {
    out.intent = raw.intent;
  } else {
    out.intent = 'search';
  }
  if (['hotel', 'activity', 'transport', 'package'].includes(raw.type)) out.type = raw.type;
  if (typeof raw.destinationName === 'string' && raw.destinationName.trim()) out.destinationName = raw.destinationName.trim();
  if (typeof raw.subjectName === 'string' && raw.subjectName.trim()) out.subjectName = raw.subjectName.trim();
  if (VALID_LOOKUP_TOPICS.includes(raw.lookupTopic)) out.lookupTopic = raw.lookupTopic;
  if (VALID_DIAGNOSTICS.includes(raw.diagnostic)) out.diagnostic = raw.diagnostic;
  // propertyType: only keep enum-valid entries; treat empty array same as null
  // (don't narrow — operator gets all property types).
  if (Array.isArray(raw.propertyType)) {
    const filtered = raw.propertyType.filter(t => VALID_PROPERTY_TYPES.includes(t));
    out.propertyType = filtered.length ? Array.from(new Set(filtered)) : null;
  }
  // Lookup intent without a subject is meaningless — demote to search and let
  // the route's clarification path ask for one.
  if (out.intent === 'lookup' && !out.subjectName) out.intent = 'search';
  // Diagnostic intent without a sub-type is meaningless — same demotion.
  if (out.intent === 'diagnostic' && !out.diagnostic) out.intent = 'search';

  if (raw.dateRange && typeof raw.dateRange === 'object') {
    const from = typeof raw.dateRange.from === 'string' ? raw.dateRange.from : null;
    const to = typeof raw.dateRange.to === 'string' ? raw.dateRange.to : null;
    out.dateRange = { from: isIsoDate(from) ? from : null, to: isIsoDate(to) ? to : null };
  }

  if (Number.isFinite(raw.adults) && raw.adults > 0) out.adults = Math.round(raw.adults);

  if (Array.isArray(raw.children)) {
    out.children = raw.children
      .slice(0, 8)
      .map(c => ({ age: Number.isFinite(c?.age) ? Math.max(0, Math.min(17, Math.round(c.age))) : null }));
  }

  if (Number.isFinite(raw.budgetMax) && raw.budgetMax > 0) out.budgetMax = raw.budgetMax;
  if (typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency)) out.currency = raw.currency;
  if (['RO', 'BB', 'HB', 'FB', 'AI'].includes(raw.boardBasis)) out.boardBasis = raw.boardBasis;
  if (['retail', 'contract', 'resident'].includes(raw.clientType)) out.clientType = raw.clientType;
  if (['citizen', 'resident', 'nonResident'].includes(raw.nationality)) out.nationality = raw.nationality;

  out.mustHave = Array.isArray(raw.mustHave) ? raw.mustHave.filter(s => typeof s === 'string').slice(0, 10) : [];
  out.niceToHave = Array.isArray(raw.niceToHave) ? raw.niceToHave.filter(s => typeof s === 'string').slice(0, 10) : [];

  if (raw.confidence && typeof raw.confidence === 'object') {
    for (const k of ['intent', 'type', 'destinationName', 'propertyType', 'subjectName', 'lookupTopic', 'diagnostic', 'dateRange', 'adults', 'children', 'budgetMax', 'clientType', 'nationality']) {
      const v = raw.confidence[k];
      out.confidence[k] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    }
  }
  return out;
}

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * Parse a natural-language query into a structured search spec.
 * Returns { parsed, usage } where usage matches the shape recordAiUsage expects.
 */
export async function parseQuery({ query, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    throw Object.assign(new Error('Empty query'), { status: 400 });
  }
  if (query.length > 500) {
    throw Object.assign(new Error('Query too long (max 500 chars)'), { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const systemPrompt = buildSystemPrompt(today);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: PARSER_MODEL,
      max_tokens: 400,
      // Cache the system prompt — same one for every search call, so subsequent
      // queries within the 5-min cache window are billed at 0.1× input cost.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Query: ${query.trim()}` }],
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
    model: PARSER_MODEL,
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadInputTokens: u.cache_read_input_tokens || 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
  };

  const raw = extractJson(text);
  const parsed = normalize(raw);
  return { parsed, usage };
}
