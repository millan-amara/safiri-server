import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { protect } from '../middleware/auth.js';
import { checkAiItineraryQuota } from '../middleware/subscription.js';
import { logAiCall } from '../utils/aiLogger.js';

const router = Router();

// Apply auth to all AI routes (no public endpoints in this router)
router.use(protect);

// Rate limit: 10 AI calls per minute per organization (keyed on org ID, not IP,
// so shared IPs in offices don't pool limits across different orgs).
const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req, res) => req.organizationId?.toString() || ipKeyGenerator(req, res),
  message: { message: 'Too many AI requests. Please slow down and try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test', // don't rate-limit in automated tests
});

router.use(aiRateLimiter);

// Helper to call Claude API
async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ─── GENERATE SEGMENT NARRATIVES ──────────────────

router.post('/generate-narrative', logAiCall('generate-narrative'), async (req, res) => {
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

    const narrative = await callClaude(system, prompt, 200);
    res.json({ narrative });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── GENERATE ALL SEGMENT NARRATIVES AT ONCE ──────

router.post('/generate-all-narratives', checkAiItineraryQuota, logAiCall('generate-all-narratives'), async (req, res) => {
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

    const raw = await callClaude(system, prompt, 1500);
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
    const result = JSON.parse(cleaned);
    res.json(result);
  } catch (error) {
    console.error('Narrative generation error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ─── AI DEAL SUMMARY ────────────────────────────

router.post('/deal-summary', logAiCall('deal-summary'), async (req, res) => {
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

    const summary = await callClaude(system, prompt, 200);
    res.json({ summary });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── AI EMAIL DRAFTING ──────────────────────────

router.post('/draft-email', logAiCall('draft-email'), async (req, res) => {
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

    const email = await callClaude(system, prompt, 500);
    res.json({ email });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── AI CSV COLUMN MAPPING ──────────────────────

router.post('/map-columns', logAiCall('map-columns'), async (req, res) => {
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

    const raw = await callClaude(system, prompt, 500);
    const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
    const result = JSON.parse(cleaned);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── AI ROUTE SUGGESTION ────────────────────────

router.post('/suggest-route', logAiCall('suggest-route'), async (req, res) => {
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

    const raw = await callClaude(system, prompt, 800);
    
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

router.post('/draft-itinerary', checkAiItineraryQuota, logAiCall('draft-itinerary'), async (req, res) => {
  try {
    const { prompt, tripLength, travelers, budget } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ message: 'Prompt required' });

    // Pull the operator's partner data so the AI can suggest real hotels/activities
    const Hotel = (await import('../models/Hotel.js')).default;
    const Activity = (await import('../models/Activity.js')).default;

    const hotels = await Hotel.find({ organization: req.organizationId, isActive: true })
      .select('name destination category description rates').lean();
    const activities = await Activity.find({ organization: req.organizationId, isActive: true })
      .select('name destination description costPerPerson groupRate').lean();

    // Build a compact catalog the AI can reference by name
    const hotelCatalog = hotels.map(h => ({
      name: h.name,
      destination: h.destination,
      category: h.category,
      pricing: h.rates?.[0] ? `${h.rates[0].ratePerNight} ${h.rates[0].currency || 'USD'}/night` : 'N/A',
    }));
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

    const userMessage = `Plan a trip based on this brief: "${prompt}"

${tripLength ? `Trip length: ${tripLength} days` : ''}
${travelers ? `Travelers: ${travelers}` : ''}
${budget ? `Budget level: ${budget}` : ''}

Available hotels in our database:
${JSON.stringify(hotelCatalog, null, 2)}

Available activities in our database:
${JSON.stringify(activityCatalog, null, 2)}

Generate the full itinerary as JSON.`;

    const response = await callClaude(systemPrompt, userMessage, 4096);

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

    // Resolve hotel and activity references from names to full objects
    const resolvedDays = (parsed.days || []).map((day, i) => {
      let hotel = null;
      if (day.hotelName) {
        const found = hotels.find(h => h.name === day.hotelName);
        if (found) {
          const rate = found.rates?.[0];
          hotel = {
            hotelId: found._id,
            name: found.name,
            roomType: rate?.roomType || '',
            ratePerNight: rate?.ratePerNight || 0,
            mealPlan: rate?.mealPlan || '',
            images: found.images || [],
            description: found.description || '',
          };
        }
      }

      const dayActivities = (day.suggestedActivities || []).map(name => {
        const found = activities.find(a => a.name === name);
        if (!found) return null;
        const totalPax = travelers || 2;
        const totalCost = found.costPerPerson ? found.costPerPerson * totalPax : (found.groupRate || 0);
        return {
          activityId: found._id,
          name: found.name,
          costPerPerson: found.costPerPerson,
          groupRate: found.groupRate,
          totalCost,
          isOptional: false,
          description: found.description,
        };
      }).filter(Boolean);

      const hotelCost = hotel?.ratePerNight || 0;
      const actCost = dayActivities.reduce((s, a) => s + (a.totalCost || 0), 0);

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

    res.json({
      title: parsed.title || '',
      coverNarrative: parsed.coverNarrative || '',
      highlights: parsed.highlights || [],
      days: resolvedDays,
    });
  } catch (error) {
    console.error('Draft itinerary error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

export default router;