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
  type: null,                 // 'hotel' | 'activity' | 'transport' | 'package' | null
  destinationName: null,      // free text — executor fuzzy-matches against Destination + partner.destination
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
  "type": "hotel" | "activity" | "transport" | "package" | null,
  "destinationName": string | null,
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
  "confidence": { "type": 0..1, "destinationName": 0..1, "dateRange": 0..1, "adults": 0..1, "children": 0..1, "budgetMax": 0..1, "clientType": 0..1, "nationality": 0..1 }
}

Rules:
- Use null when the operator did not specify a value. NEVER guess dates, pax, or budget — leave them null with confidence 0.
- "type": infer from context. Hotel/lodge/camp/resort/where to stay → "hotel". Game drive/walk/excursion → "activity". Transfer/4x4/van/flight → "transport". Multi-day combo/package/trail → "package". When the query mentions a specific lodging concept first, prefer "hotel".
- "children": one entry per child. If the operator says "1 kid" without an age, return [{ "age": null }]. If "2 kids ages 5 and 9", return [{ "age": 5 }, { "age": 9 }].
- "budgetMax": parse "50k" as 50000, "1.2m" as 1200000. If the operator writes "USD 500" or "$500" → currency "USD" budgetMax 500. If "KES 50,000" or "50k KES" or "Ksh 50000" → currency "KES" budgetMax 50000. If just a bare number with no currency, leave currency null.
- "boardBasis": "full board" → FB, "half board" → HB, "bed and breakfast" or "B&B" → BB, "all inclusive" → AI, "room only" → RO.
- "clientType": who's buying — selects which audience-tagged rate list applies. "retail/public/rack/walk-in/direct" → "retail". "contract/DMC/agent/trade/STO/tour operator" → "contract". "resident/EAC/East African" rates (priced for someone living locally) → "resident". Leave null if the operator didn't say.
- "nationality": traveler nationality — selects park-fee/visa-fee tier. "citizen/Kenyan/Tanzanian/local" → "citizen". "resident/expat/work-permit holder" → "resident". "non-resident/foreigner/international/overseas" → "nonResident". Note: "resident" can mean either clientType or nationality — set both if the operator clearly means resident-priced AND resident traveler; otherwise pick the one that fits context. Leave null if the operator didn't say.
- "mustHave"/"niceToHave": short literal qualitative cues from the query ("pool", "tented", "luxury", "honeymoon"). Don't invent — only include what the operator wrote. Don't put clientType/nationality words here; they have their own fields.
- "confidence": 1.0 when the operator's intent is unambiguous, 0.5 when partly inferred (e.g. you assumed the year), 0.0 when the field is null because the operator didn't say. Always include all eight confidence keys.

Examples:

Query: "hotel for 2 adults and 1 kid in Maasai Mara July budget 50k USD"
{
  "type": "hotel",
  "destinationName": "Maasai Mara",
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
  "confidence": { "type": 1, "destinationName": 1, "dateRange": 0.5, "adults": 1, "children": 0.7, "budgetMax": 1, "clientType": 0, "nationality": 0 }
}

Query: "tented camp in Mara"
{
  "type": "hotel",
  "destinationName": "Mara",
  "dateRange": { "from": null, "to": null },
  "adults": null,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": null,
  "nationality": null,
  "mustHave": ["tented camp"],
  "niceToHave": [],
  "confidence": { "type": 1, "destinationName": 0.8, "dateRange": 0, "adults": 0, "children": 0, "budgetMax": 0, "clientType": 0, "nationality": 0 }
}

Query: "game drive amboseli for 4"
{
  "type": "activity",
  "destinationName": "Amboseli",
  "dateRange": { "from": null, "to": null },
  "adults": 4,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": null,
  "nationality": null,
  "mustHave": ["game drive"],
  "niceToHave": [],
  "confidence": { "type": 1, "destinationName": 1, "dateRange": 0, "adults": 0.9, "children": 0, "budgetMax": 0, "clientType": 0, "nationality": 0 }
}

Query: "lodge in Maasai Mara contract rate for 2 Kenyan citizens"
{
  "type": "hotel",
  "destinationName": "Maasai Mara",
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
  "confidence": { "type": 1, "destinationName": 1, "dateRange": 0, "adults": 1, "children": 0, "budgetMax": 0, "clientType": 1, "nationality": 1 }
}

Query: "resident-rate camp in Amboseli for non-resident travelers"
{
  "type": "hotel",
  "destinationName": "Amboseli",
  "dateRange": { "from": null, "to": null },
  "adults": null,
  "children": [],
  "budgetMax": null,
  "currency": null,
  "boardBasis": null,
  "clientType": "resident",
  "nationality": "nonResident",
  "mustHave": [],
  "niceToHave": [],
  "confidence": { "type": 1, "destinationName": 1, "dateRange": 0, "adults": 0, "children": 0, "budgetMax": 0, "clientType": 1, "nationality": 1 }
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
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PARSED };
  const out = { ...EMPTY_PARSED, confidence: {} };

  if (['hotel', 'activity', 'transport', 'package'].includes(raw.type)) out.type = raw.type;
  if (typeof raw.destinationName === 'string' && raw.destinationName.trim()) out.destinationName = raw.destinationName.trim();

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
    for (const k of ['type', 'destinationName', 'dateRange', 'adults', 'children', 'budgetMax', 'clientType', 'nationality']) {
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
