import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { protect } from '../middleware/auth.js';
import { checkAiCredits } from '../middleware/subscription.js';
import { logAiCall, recordAiUsage } from '../utils/aiLogger.js';
import { AI_CREDIT_COST, getPlan } from '../config/plans.js';
import { Deal } from '../models/Deal.js';

const heavy  = checkAiCredits(AI_CREDIT_COST.heavy);
const medium = checkAiCredits(AI_CREDIT_COST.medium);
const light  = checkAiCredits(AI_CREDIT_COST.light);

const router = Router();

// Apply auth to all AI routes (no public endpoints in this router)
router.use(protect);

// Plan-aware rate limit: Starter 5/min, Pro 10, Business 20, Enterprise 30.
// Keyed on org ID so shared office IPs don't pool limits across orgs.
const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => getPlan(req.organization?.plan).aiRateLimitPerMin,
  keyGenerator: (req, res) => req.organizationId?.toString() || ipKeyGenerator(req, res),
  message: { message: 'Too many AI requests. Please slow down and try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

router.use(aiRateLimiter);

// Helper to call Claude API. Returns { text, usage } so callers can hand the
// usage to recordAiUsage() for accurate per-call cost logging.
//
// `userMessage` is either a string or an array of content blocks (the API
// accepts both shapes). Pass `cacheSystem: true` to wrap the system prompt in
// a cache_control'd block — useful when the same long system prompt is reused.
async function callClaude(systemPrompt, userMessage, options = {}) {
  const {
    maxTokens = 1024,
    model = 'claude-sonnet-4-6',
    cacheSystem = false,
  } = options;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const system = cacheSystem
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
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
  return {
    text,
    usage: {
      model,
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadInputTokens: u.cache_read_input_tokens || 0,
      cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
    },
  };
}

// ─── GENERATE SEGMENT NARRATIVES ──────────────────

router.post('/generate-narrative', medium, logAiCall('generate-narrative'), async (req, res) => {
  try {
    const { destination, hotel, activities, nights, dayNumber, isFirst, travelers } = req.body;

    const system = `You are an expert travel writer creating compelling itinerary narratives for safari and travel quotes. Write in second person ("you'll"), warm and evocative but concise. Match the tone of premium safari operators — professional yet personal.

Rules:
- Keep each narrative to 2-3 sentences max
- Mention specific destination features that make it special
- If a hotel name is provided, work it in naturally
- Reference key activities if provided
- Don't use cliché phrases like "trip of a lifetime"
- Be specific about what makes this destination unique`;

    const prompt = `Write a brief narrative for this itinerary segment:

Destination: ${destination}
Nights: ${nights}
${hotel ? `Hotel: ${hotel}` : ''}
${activities?.length ? `Activities: ${activities.join(', ')}` : ''}
Travelers: ${travelers || 2} people
Day ${dayNumber} of the trip${isFirst ? ' (first stop)' : ''}

Return ONLY the narrative text, nothing else.`;

    const { text: narrative, usage } = await callClaude(system, prompt, {
      maxTokens: 200,
      model: 'claude-haiku-4-5',
    });
    recordAiUsage(req, usage);
    res.json({ narrative });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── GENERATE ALL SEGMENT NARRATIVES AT ONCE ──────

router.post('/generate-all-narratives', heavy, logAiCall('generate-all-narratives'), async (req, res) => {
  try {
    const { segments, tripTitle, travelers } = req.body;

    const system = `You are an expert travel writer creating itinerary narratives for safari/travel quotes. Write in second person ("you'll"), warm and evocative but concise. Match premium safari operator tone.

Rules:
- 2-3 sentences per segment
- Mention destination-specific features
- Reference the hotel name naturally
- Vary your openings — don't start each with the same pattern
- Be specific, not generic
- Respond in valid JSON only`;

    const segmentDescriptions = segments.map((s, i) => ({
      index: i,
      destination: s.destination,
      nights: s.nights,
      hotel: s.hotel?.name || null,
      activities: s.activities?.map(a => a.name) || [],
    }));

    const prompt = `Generate narratives for each segment of this trip: "${tripTitle}" for ${travelers || 2} travelers.

Segments:
${JSON.stringify(segmentDescriptions, null, 2)}

Also generate:
1. A coverNarrative (2-3 sentences introducing the whole trip)
2. A closingNote (1-2 sentences wrapping up)
3. An array of 3-5 trip highlights (short phrases)

Respond ONLY with this JSON structure:
{
  "coverNarrative": "...",
  "closingNote": "...",
  "highlights": ["...", "..."],
  "segments": [
    { "index": 0, "narrative": "..." },
    { "index": 1, "narrative": "..." }
  ]
}`;

    const { text: raw, usage } = await callClaude(system, prompt, { maxTokens: 1500 });
    recordAiUsage(req, usage);
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
    const result = JSON.parse(cleaned);
    res.json(result);
  } catch (error) {
    console.error('Narrative generation error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ─── AI DEAL SUMMARY ────────────────────────────

router.post('/deal-summary', light, logAiCall('deal-summary'), async (req, res) => {
  try {
    const { deal, activities, quotes } = req.body;

    const system = `You are a travel sales assistant. Summarize deal status concisely for the operator. Be actionable — suggest next steps. 2-3 sentences max.`;

    const prompt = `Summarize this deal:

Title: ${deal.title}
Stage: ${deal.stage}
Contact: ${deal.contactName || 'Unknown'}
Destination: ${deal.destination || 'Not set'}
Dates: ${deal.dates || 'Not set'}
Group size: ${deal.groupSize || 'Not set'}
Budget: ${deal.budget || 'Not set'}
Number of quotes sent: ${quotes || 0}
Recent activity: ${activities?.slice(0, 3).join('; ') || 'None'}

Provide a brief summary and suggest the best next action.`;

    const { text: summary, usage } = await callClaude(system, prompt, {
      maxTokens: 200,
      model: 'claude-haiku-4-5',
    });
    recordAiUsage(req, usage);
    res.json({ summary });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── AI EMAIL DRAFTING ──────────────────────────

router.post('/draft-email', light, logAiCall('draft-email'), async (req, res) => {
  try {
    const { context, type, recipientName, senderName, companyName } = req.body;

    const system = `You are a travel sales assistant. Draft professional, warm emails for safari/travel operators. Keep them concise — 3-5 short paragraphs. Use a friendly but professional tone. Don't be overly formal.`;

    const typePrompts = {
      follow_up: `Draft a follow-up email after sending a quote. The client hasn't responded yet.`,
      quote_send: `Draft an email to accompany a new quote/proposal being sent.`,
      thank_you: `Draft a thank-you email after a client confirms a booking.`,
      custom: `Draft a professional email based on the context below.`,
    };

    const prompt = `${typePrompts[type] || typePrompts.custom}

Context: ${context}
Recipient: ${recipientName || 'the client'}
From: ${senderName || 'the team'} at ${companyName || 'our company'}

Return ONLY the email body (no subject line).`;

    const { text: email, usage } = await callClaude(system, prompt, {
      maxTokens: 500,
      model: 'claude-haiku-4-5',
    });
    recordAiUsage(req, usage);
    res.json({ email });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── AI CSV COLUMN MAPPING ──────────────────────

router.post('/map-columns', light, logAiCall('map-columns'), async (req, res) => {
  try {
    const { sourceColumns, sampleRows } = req.body;

    const targetFields = [
      'firstName', 'lastName', 'email', 'phone', 'company',
      'position', 'country', 'source', 'notes', 'tags',
      'budget', 'interests', 'groupSize',
    ];

    const system = `You are a data mapping assistant. Map CSV column names to standard CRM contact fields. Return valid JSON only.`;

    const prompt = `Map these CSV columns to our CRM contact fields.

CSV columns: ${JSON.stringify(sourceColumns)}

Sample data (first 2 rows):
${JSON.stringify(sampleRows?.slice(0, 2))}

Available target fields: ${JSON.stringify(targetFields)}

For each source column, determine the best matching target field, or null if no match.

Respond ONLY with JSON:
{
  "mappings": {
    "SourceColumnName": "targetFieldName",
    "AnotherColumn": "anotherField",
    "IrrelevantColumn": null
  },
  "confidence": "high" | "medium" | "low"
}`;

    const { text: raw, usage } = await callClaude(system, prompt, {
      maxTokens: 500,
      model: 'claude-haiku-4-5',
    });
    recordAiUsage(req, usage);
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
    const result = JSON.parse(cleaned);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── AI ROUTE SUGGESTION ────────────────────────

router.post('/suggest-route', medium, logAiCall('suggest-route'), async (req, res) => {
  console.log('Route suggestion request:', JSON.stringify(req.body).substring(0, 200));
  try {
    const { landingCity, tripLength, interests, budget, destinations, travelers, tourType } = req.body;

    const system = `You are a Kenya safari route planning expert. Suggest optimal multi-destination itineraries based on client preferences. Consider: driving distances, logical flow (don't zigzag), experience variety, and practical transfer times. You MUST respond with valid JSON only — no markdown, no backticks, no explanation outside the JSON.`;

    const destList = destinations?.length > 0
      ? destinations.join(', ')
      : 'Maasai Mara, Amboseli, Tsavo East, Tsavo West, Diani Beach, Naivasha, Lake Nakuru, Samburu, Nairobi, Mombasa';

    const prompt = `Plan a route for:
- Landing in: ${landingCity || 'Nairobi'}
- Trip length: ${tripLength || 7} days
- Travelers: ${travelers || '2 adults'}
- Tour type: ${tourType || 'private'}
- Interests: ${interests?.join(', ') || 'safari and beach'}
- Budget level: ${budget || 'mid-range'}
- Available destinations in our database: ${destList}

IMPORTANT: Only use destinations from the list above. Suggest the optimal route with nights per destination. Total nights must equal ${tripLength || 7}.

Respond ONLY with this JSON structure, nothing else:
{"route":[{"destination":"...","nights":2,"reason":"..."}],"summary":"...","transportNotes":"..."}`;

    const { text: raw, usage } = await callClaude(system, prompt, {
      maxTokens: 800,
      model: 'claude-haiku-4-5',
    });
    recordAiUsage(req, usage);

    // Clean and parse — handle various AI response formats
    let cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    // Find the first { and last }
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('AI route response not JSON:', raw.substring(0, 200));
      return res.status(500).json({ message: 'AI returned an invalid response. Please try again.' });
    }
    cleaned = cleaned.substring(start, end + 1);
    
    const result = JSON.parse(cleaned);
    res.json(result);
  } catch (error) {
    console.error('Route suggestion error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

// ─── DRAFT FULL ITINERARY FROM PROMPT ─────────────

router.post('/draft-itinerary', heavy, logAiCall('draft-itinerary'), async (req, res) => {
  try {
    const {
      prompt,
      tripLength,
      travelers,
      budget,
      // New: passed through to the rate resolver so nightly costs reflect
      // the real deal configuration rather than hotel.rates[0].
      startDate,
      adults,
      childAges = [],
      clientType = 'retail',
      nationality = 'nonResident',
      quoteCurrency,
      preferredMealPlan,
    } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ message: 'Prompt required' });

    const Hotel = (await import('../models/Hotel.js')).default;
    const Activity = (await import('../models/Activity.js')).default;
    const Destination = (await import('../models/Destination.js')).default;
    const { priceStay, summarizeCheapestRate } = await import('../services/rateResolver.js');
    const { priceActivity } = await import('../services/activityPricer.js');

    const effectiveCurrency = quoteCurrency || req.organization?.defaults?.currency || 'USD';
    const orgFxOverrides = req.organization?.fxRates || {};
    const effectiveAdults = adults || travelers || 2;
    const effectiveStart = startDate ? new Date(startDate) : null;

    const MAX_CATALOG_PER_TYPE = 60;

    // Build the destination vocabulary from the org's Hotels and Activities (authoritative —
    // these are what the operator actually has inventory for) plus the Destinations collection.
    const orgScope = { organization: req.organizationId, isActive: true };
    const [destRecords, hotelDests, actDests] = await Promise.all([
      Destination.find(orgScope).select('name').lean(),
      Hotel.distinct('destination', orgScope),
      Activity.distinct('destination', orgScope),
    ]);
    const vocab = [...new Set(
      [...destRecords.map(d => d.name), ...hotelDests, ...actDests]
        .filter(Boolean)
        .map(s => s.trim())
    )];

    // Use Haiku to semantically match the user's free-text prompt against the operator's
    // destination vocabulary. Handles synonyms ("beach" → "Diani"), abbreviations ("Mara"
    // → "Maasai Mara"), and thematic intent ("safari" → Mara/Amboseli/Samburu).
    // Costs ~$0.001 per call — negligible vs the main itinerary call.
    let matchedDestinations = [];
    if (vocab.length > 0) {
      try {
        const extractorSystem = `You match a user's travel request to destinations the operator services. You MUST respond with valid JSON only — no markdown, no commentary. Return the EXACT names from the provided list (case-sensitive, including spelling). If the user's request is vague (e.g. "beach", "safari"), pick all reasonable thematic matches. If nothing matches, return an empty array.`;
        const extractorPrompt = `Operator's destinations: ${JSON.stringify(vocab)}

User request: "${prompt}"${tripLength ? `\nTrip length: ${tripLength} days` : ''}${budget ? `\nBudget: ${budget}` : ''}

Respond ONLY with JSON: { "destinations": ["ExactName1", "ExactName2"] }`;
        const { text: extractorRaw, usage: extractorUsage } = await callClaude(
          extractorSystem,
          extractorPrompt,
          { maxTokens: 300, model: 'claude-haiku-4-5' }
        );
        recordAiUsage(req, extractorUsage);
        const cleaned = extractorRaw.replace(/```json\s*|\s*```/g, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          const parsed = JSON.parse(cleaned.substring(start, end + 1));
          matchedDestinations = (parsed.destinations || []).filter(name => vocab.includes(name));
        }
      } catch (e) {
        console.warn('[draft-itinerary] destination extractor failed, falling back to substring match:', e.message);
        const promptLower = prompt.toLowerCase();
        matchedDestinations = vocab.filter(name => promptLower.includes(name.toLowerCase()));
      }
    }

    // If nothing matches, send an empty catalog. Claude will produce a valid plan skeleton
    // with null hotels/empty activities — honest signal that inventory is missing, rather
    // than silently suggesting mismatched hotels.
    const noMatch = matchedDestinations.length === 0;
    const hotelFilter = { ...orgScope };
    const activityFilter = { ...orgScope };
    if (noMatch) {
      hotelFilter._id = null;
      activityFilter._id = null;
    } else {
      hotelFilter.destination = { $in: matchedDestinations };
      activityFilter.destination = { $in: matchedDestinations };
    }

    const hotels = await Hotel.find(hotelFilter)
      .select('name destination type description rateLists currency images location stars amenities coordinates contactEmail contactPhone tags')
      .sort({ updatedAt: -1 })
      .limit(MAX_CATALOG_PER_TYPE)
      .lean();
    const activities = await Activity.find(activityFilter)
      .select('name destination description costPerPerson groupRate pricingModel currency images duration minimumAge maxGroupSize season tags commissionRate notes isOptional')
      .sort({ updatedAt: -1 })
      .limit(MAX_CATALOG_PER_TYPE)
      .lean();

    // Build a compact catalog the AI can reference by name. Use the rate
    // resolver's summary so Claude sees the right audience's price.
    const hotelCatalog = hotels.map(h => {
      const summary = summarizeCheapestRate(h, {
        clientType,
        date: effectiveStart || new Date(),
        quoteCurrency: effectiveCurrency,
        orgFxOverrides,
      });
      return {
        name: h.name,
        destination: h.destination,
        type: h.type,
        pricing: summary?.label || 'No matching rate list',
      };
    });
    const activityCatalog = activities.map(a => ({
      name: a.name,
      destination: a.destination,
      pricing: a.costPerPerson ? `${a.costPerPerson}/person` : a.groupRate ? `${a.groupRate}/group` : 'N/A',
    }));

    const systemPrompt = `You are an expert African safari and travel itinerary planner. You design day-by-day itineraries that flow naturally between destinations.

You MUST respond with valid JSON only — no preamble, no markdown code blocks, no commentary. Just JSON.

The JSON shape is:
{
  "title": "string — short trip title",
  "coverNarrative": "string — 2-3 sentence overview of the trip",
  "highlights": ["array of 4-6 short highlight phrases"],
  "days": [
    {
      "title": "string — short day title like 'Arrive in Nairobi' or 'Game drive in Mara'",
      "location": "string — destination name",
      "isTransitDay": false,
      "narrative": "string — 2-4 sentences describing the day",
      "meals": { "breakfast": true, "lunch": true, "dinner": true },
      "hotelName": "string — name from the hotel catalog if a good match exists, otherwise null",
      "suggestedActivities": ["array of activity names from the catalog if matches exist"]
    }
  ]
}

When suggesting hotels and activities, ONLY use names that exist in the provided catalogs. If no good match exists for a location, set hotelName to null and suggestedActivities to []. Match locations by name — if the user mentions "Mara" use hotels in "Maasai Mara" etc.

Plan logistics carefully: don't put two far-apart destinations on the same day, allow travel time, group consecutive nights at the same location.`;

    // Catalog goes first as a cache_control'd block — it's stable per operator
    // across rapid drafts. Variable bits (prompt, trip length, etc.) follow
    // after the breakpoint so they can change per request without invalidating.
    // System prompt + catalog comfortably exceeds the 2048-token Sonnet cache
    // floor, so the prefix actually caches.
    const catalogBlock = `Available hotels in our database:
${JSON.stringify(hotelCatalog, null, 2)}

Available activities in our database:
${JSON.stringify(activityCatalog, null, 2)}`;

    const variableBlock = `Plan a trip based on this brief: "${prompt}"

${tripLength ? `Trip length: ${tripLength} days` : ''}
${travelers ? `Travelers: ${travelers}` : ''}
${budget ? `Budget level: ${budget}` : ''}

Generate the full itinerary as JSON.`;

    const userBlocks = [
      { type: 'text', text: catalogBlock, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: variableBlock },
    ];

    const { text: response, usage } = await callClaude(systemPrompt, userBlocks, { maxTokens: 4096 });
    recordAiUsage(req, usage);

    // Parse JSON response
    let parsed;
    try {
      // Strip any markdown code fences if Claude added them
      const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse AI response:', response);
      return res.status(500).json({ message: 'AI returned invalid format. Try rephrasing your prompt.' });
    }

    // Resolve hotel and activity references from names to full objects.
    // For hotels, run the rate resolver with the trip's checkIn = startDate + i
    // and checkOut = +1 night, so per-day pricing reflects real season / audience.
    const resolvedDays = (parsed.days || []).map((day, i) => {
      let hotel = null;
      if (day.hotelName) {
        const found = hotels.find(h => h.name === day.hotelName);
        if (found) {
          const checkIn = effectiveStart ? new Date(effectiveStart) : new Date();
          checkIn.setDate(checkIn.getDate() + i);
          const checkOut = new Date(checkIn);
          checkOut.setDate(checkOut.getDate() + 1);

          const priced = priceStay({
            hotel: found,
            checkIn,
            checkOut,
            pax: { adults: effectiveAdults, childAges },
            clientType,
            nationality,
            preferredMealPlan,
            quoteCurrency: effectiveCurrency,
            orgFxOverrides,
          });

          if (priced.ok) {
            const night = priced.nightly[0] || {};
            hotel = {
              hotelId: found._id,
              name: found.name,
              images: found.images || [],
              description: found.description || '',
              // Hotel-level display fields (mirrors selectHotelForDay snapshot)
              location: found.location || '',
              type: found.type || '',
              stars: found.stars || null,
              amenities: found.amenities || [],
              coordinates: found.coordinates || null,
              contactEmail: found.contactEmail || '',
              contactPhone: found.contactPhone || '',
              tags: found.tags || [],
              // Rate list snapshot
              rateListId: priced.rateList._id,
              rateListName: priced.rateList.name,
              audienceApplied: priced.rateList.audience,
              mealPlan: priced.rateList.mealPlan,
              mealPlanLabel: priced.rateList.mealPlanLabel || '',
              sourceCurrency: priced.sourceCurrency,
              fxRate: priced.fxRate,
              // Per-night rollup
              roomType: priced.roomType,
              seasonLabel: night.season,
              // night.total includes per-night mandatory add-ons rolled in
              // by the resolver (resort fees, conservancy access, etc.).
              ratePerNight: night.total || 0,                              // source currency
              ratePerNightInQuoteCurrency: (night.total || 0) * priced.fxRate,
              supplements: night.supplements || [],
              // Surfaced but not added to nightly cost — caller can itemize
              passThroughFees: priced.passThroughFees,
              addOns: priced.addOns,
              mandatoryAddOnsPerNight: priced.mandatoryAddOnsPerNight || [],
              mandatoryAddOnsPerNightTotal: priced.mandatoryAddOnsPerNightTotal || 0,
              cancellationTiers: priced.cancellationTiers,
              depositPct: priced.depositPct,
              bookingTerms: priced.bookingTerms || '',
              rateListNotes: priced.notes || '',
              inclusions: priced.inclusions || [],
              exclusions: priced.exclusions || [],
              warnings: priced.warnings,
            };
          } else {
            // Pricing couldn't resolve — keep a thin snapshot so the UI
            // surfaces "no rate available" rather than silently dropping the pick.
            hotel = {
              hotelId: found._id,
              name: found.name,
              images: found.images || [],
              description: found.description || '',
              location: found.location || '',
              type: found.type || '',
              stars: found.stars || null,
              amenities: found.amenities || [],
              coordinates: found.coordinates || null,
              contactEmail: found.contactEmail || '',
              contactPhone: found.contactPhone || '',
              tags: found.tags || [],
              ratePerNight: 0,
              ratePerNightInQuoteCurrency: 0,
              sourceCurrency: found.currency || effectiveCurrency,
              warnings: [priced.reason || 'pricing_unavailable', ...(priced.warnings || [])],
            };
          }
        }
      }

      const dayActivities = (day.suggestedActivities || []).map(name => {
        const found = activities.find(a => a.name === name);
        if (!found) return null;
        const priced = priceActivity(found, {
          adults: effectiveAdults,
          children: (childAges || []).length,
          childAges: childAges || [],
          quoteCurrency: effectiveCurrency,
          orgFxOverrides,
        });
        return {
          activityId: found._id,
          name: found.name,
          description: found.description,
          // Pricing context (Chunk 1)
          costPerPerson: found.costPerPerson,
          groupRate: found.groupRate,
          pricingModel: priced.pricingModel,
          sourceCurrency: priced.sourceCurrency,
          fxRate: priced.fxRate,
          totalCost: priced.totalCost,
          totalCostInQuoteCurrency: priced.totalCostInQuoteCurrency,
          warnings: priced.warnings,
          // Display + constraint context (Chunk 4)
          images: found.images || [],
          duration: found.duration || 0,
          destination: found.destination || '',
          minimumAge: found.minimumAge || 0,
          maxGroupSize: found.maxGroupSize || 0,
          season: found.season || 'all',
          tags: found.tags || [],
          commissionRate: found.commissionRate || 0,
          notes: found.notes || '',
          isOptional: !!found.isOptional,
        };
      }).filter(Boolean);

      const hotelCost = hotel?.ratePerNightInQuoteCurrency || hotel?.ratePerNight || 0;
      const actCost = dayActivities.reduce((s, a) => s + (a.totalCostInQuoteCurrency ?? a.totalCost ?? 0), 0);

      return {
        dayNumber: i + 1,
        title: day.title || '',
        location: day.location || '',
        isTransitDay: day.isTransitDay || false,
        narrative: day.narrative || '',
        meals: {
          breakfast: day.meals?.breakfast ?? false,
          lunch: day.meals?.lunch ?? false,
          dinner: day.meals?.dinner ?? false,
          notes: '',
        },
        hotel,
        roomType: hotel?.roomType || '',
        activities: dayActivities,
        transport: null,
        images: hotel?.images || [],
        dayCost: hotelCost + actCost,
      };
    });

    // Surface catalog-match context so the UI can show the operator exactly what we
    // pulled from their inventory (and hint when something they asked for wasn't found).
    res.json({
      title: parsed.title || '',
      coverNarrative: parsed.coverNarrative || '',
      highlights: parsed.highlights || [],
      days: resolvedDays,
      catalog: {
        matchedDestinations,
        hotelsUsed: hotels.length,
        activitiesUsed: activities.length,
        emptyCatalog: noMatch,
      },
    });
  } catch (error) {
    console.error('Draft itinerary error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

// ─── DRAFT SCHEDULED PRE-TRIP MESSAGE ────────────────
// Used by the deal-detail "Scheduled messages" panel. Returns a ready-to-edit
// subject + body the operator can tweak before scheduling. Medium credit cost.

router.post('/draft-scheduled-message', medium, logAiCall('draft-scheduled-message'), async (req, res) => {
  try {
    const { dealId, kind = 'general', notes = '' } = req.body;
    if (!dealId) return res.status(400).json({ message: 'dealId is required' });

    const deal = await Deal.findOne({ _id: dealId, organization: req.organizationId })
      .populate('contact', 'firstName lastName')
      .lean();
    if (!deal) return res.status(404).json({ message: 'Deal not found' });

    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'TBD';

    const dealContext = `
- Client: ${deal.contact?.firstName || 'the client'} ${deal.contact?.lastName || ''}
- Trip: ${deal.title}
- Destination: ${deal.destination || 'unspecified'}
- Travel dates: ${fmtDate(deal.travelDates?.start)} to ${fmtDate(deal.travelDates?.end)}
- Group: ${deal.groupSize || 'unknown'} travelers
- Trip type: ${deal.tripType || 'unspecified'}
- Interests: ${(deal.interests || []).join(', ') || 'none specified'}
- Special requests: ${deal.specialRequests || 'none'}
`.trim();

    const kindHints = {
      general: 'A general pre-trip touch-base message — friendly check-in.',
      packing: 'Packing tips and what to bring for this destination and travel style.',
      pickup: 'Confirming pickup arrangements and final logistics, sent 2-3 days before departure.',
      review: 'A polite request for a review or feedback after their return.',
      followup: 'A general post-trip follow-up checking in on how the trip went.',
      welcome: 'A welcome message right after booking, setting expectations and next steps.',
    };

    const system = `You are a tour operator drafting a friendly, professional message to a client. Keep it warm, personal, and specific to their trip — not marketing speak. Use the client's first name. Be concise (under 200 words). Vary your openings; don't start every message with "Dear".

The body supports light Markdown: **bold** for emphasis, *italic* for subtler emphasis, "- " bullets for short lists, [link text](url) for links. Paragraph breaks are blank lines. Use formatting sparingly — a couple of bolds or a single bullet list at most. Don't add headings.

Output format (strict):
SUBJECT: <one-line subject>
BODY:
<message body in light Markdown, with paragraph breaks>`;

    const prompt = `Draft a pre-trip message of this type: ${kindHints[kind] || kindHints.general}

${notes ? `Operator's note for this specific message: ${notes}\n\n` : ''}Trip details:
${dealContext}`;

    const { text: response, usage } = await callClaude(system, prompt, {
      maxTokens: 600,
      model: 'claude-haiku-4-5',
    });
    recordAiUsage(req, usage);

    // Parse the response into subject + body. Be lenient — if the model didn't
    // follow the format we still want to surface something usable.
    const subjectMatch = response.match(/^SUBJECT:\s*(.+)$/im);
    const bodyMatch = response.match(/BODY:\s*([\s\S]+)$/i);
    const subject = subjectMatch?.[1]?.trim() || '';
    const body = (bodyMatch?.[1] || response).trim();

    res.json({ subject, body });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;