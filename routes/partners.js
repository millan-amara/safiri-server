import { Router } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import Hotel from '../models/Hotel.js';
import Transport from '../models/Transport.js';
import Activity from '../models/Activity.js';
import Destination from '../models/Destination.js';
import Package from '../models/Package.js';
import { protect } from '../middleware/auth.js';
import { requirePartnerQuota, enforceImageCap, enforceCsvRowCap } from '../middleware/partnerQuota.js';
import { priceStay } from '../services/rateResolver.js';
import { checkAiCredits } from '../middleware/subscription.js';
import { logAiCall } from '../utils/aiLogger.js';
import { AI_CREDIT_COST } from '../config/plans.js';

// Counts total rows across all sheets in an XLSX/CSV workbook.
const xlsxRowCounter = (file) => {
  const wb = XLSX.read(file.buffer, { type: 'buffer' });
  return wb.SheetNames.reduce((sum, sheet) => sum + XLSX.utils.sheet_to_json(wb.Sheets[sheet]).length, 0);
};

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// ─── HOTELS ────────────────────────────────────────

router.get('/hotels', protect, async (req, res) => {
  try {
    const { destination, search, page = 1, limit = 50 } = req.query;
    const filter = { organization: req.organizationId, isActive: true };
    if (destination) filter.destination = new RegExp(destination, 'i');
    if (search) filter.$text = { $search: search };
    
    const hotels = await Hotel.find(filter)
      .sort({ destination: 1, name: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await Hotel.countDocuments(filter);
    
    res.json({ hotels, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/hotels/:id', protect, async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!hotel) return res.status(404).json({ message: 'Not found' });
    res.json(hotel);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/hotels', protect, requirePartnerQuota('hotel'), enforceImageCap, async (req, res) => {
  try {
    // Auto-create destination if the org doesn't already have one by that name.
    // Both find + create are org-scoped — Destinations are per-org inventory.
    if (req.body.destination) {
      const existing = await Destination.findOne({
        organization: req.organizationId,
        name: { $regex: new RegExp(`^${req.body.destination}$`, 'i') },
      });
      if (!existing) {
        await Destination.create({
          organization: req.organizationId,
          name: req.body.destination,
          country: 'Kenya',
        });
      }
    }
    const hotel = await Hotel.create({ ...req.body, organization: req.organizationId });
    res.status(201).json(hotel);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/hotels/:id', protect, enforceImageCap, async (req, res) => {
  try {
    const hotel = await Hotel.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!hotel) return res.status(404).json({ message: 'Hotel not found' });
    res.json(hotel);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Run the rate resolver against a hotel for a specific stay window + party.
// Returns the full priceStay payload (chosen rate list, nightly breakdown,
// pass-through fees, add-ons, FX). Used by the quote builder when an operator
// picks a hotel for a day — avoids duplicating resolver logic in the client.
router.post('/hotels/:id/price-stay', protect, async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ _id: req.params.id, organization: req.organizationId }).lean();
    if (!hotel) return res.status(404).json({ message: 'Hotel not found' });

    const {
      checkIn,
      checkOut,
      adults = 2,
      childAges = [],
      rooms,
      clientType = 'retail',
      nationality = 'nonResident',
      preferredMealPlan,
      preferredRoomType,
      quoteCurrency,
    } = req.body;

    if (!checkIn || !checkOut) {
      return res.status(400).json({ message: 'checkIn and checkOut are required' });
    }

    const effectiveCurrency = quoteCurrency || req.organization?.defaults?.currency || 'USD';
    const orgFxOverrides = req.organization?.fxRates || {};

    const priced = priceStay({
      hotel,
      checkIn: new Date(checkIn),
      checkOut: new Date(checkOut),
      pax: { adults: parseInt(adults, 10) || 2, childAges },
      rooms,
      clientType,
      nationality,
      preferredMealPlan,
      preferredRoomType,
      quoteCurrency: effectiveCurrency,
      orgFxOverrides,
    });

    res.json(priced);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Extract hotel rate lists from an uploaded PDF (partner rate card). Uses
// Claude's native PDF support. Returns a draft hotel shape the UI can preview
// before committing — we never write to the DB from this endpoint. This keeps
// the operator in the loop for rate-card transcription, which is high-stakes.
router.post('/hotels/extract-pdf',
  protect,
  checkAiCredits(AI_CREDIT_COST.heavy),
  logAiCall('extract-rate-card'),
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: 'No PDF uploaded' });
      if (req.file.mimetype !== 'application/pdf') {
        return res.status(400).json({ message: 'File must be a PDF' });
      }
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ message: 'ANTHROPIC_API_KEY not configured' });

      const base64 = req.file.buffer.toString('base64');
      const knownDestination = req.body?.destination || '';

      const systemPrompt = `You extract hotel rate cards into structured JSON for a safari-itinerary app.

You MUST respond with ONLY valid JSON — no markdown, no commentary. The schema is:
{
  "name": "string",
  "destination": "string — region/national park",
  "location": "string — sub-area",
  "stars": number 1-5,
  "type": "hotel" | "lodge" | "tented_camp" | "resort" | "villa" | "apartment" | "guesthouse" | "conservancy_camp",
  "description": "string — short (~2 sentences)",
  "currency": "USD" | "EUR" | "GBP" | "KES" | "TZS" | "UGX" | ...,
  "rateLists": [
    {
      "name": "string — 'Rack 2026', 'STO 2026', 'Resident Pricelist', 'Feb Flash', etc.",
      "audience": ["retail" | "contract" | "resident"],
      "currency": "USD" | "KES" | ...,
      "validFrom": "YYYY-MM-DD",
      "validTo": "YYYY-MM-DD",
      "priority": number (higher = wins; promos > base),
      "mealPlan": "RO" | "BB" | "HB" | "FB" | "AI" | "GAME_PACKAGE",
      "mealPlanLabel": "Full Board" | "Game Package incl. drives" etc.,
      "depositPct": number,
      "bookingTerms": "string — free text",
      "seasons": [
        {
          "label": "High" | "Mid" | "Low" | "Peak" | "Shoulder" | "Weekend" | "Weekday",
          "minNights": number,
          "dateRanges": [{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }],
          "daysOfWeek": [0,1,2,3,4,5,6]  // 0=Sun..6=Sat — OMIT when the season applies every day. USE when the PDF has weekday/weekend splits.
          "specificDates": ["YYYY-MM-DD", ...]  // OPTIONAL list of individual dates that also count as this season. Use for public holidays grouped with weekend pricing in the PDF.
          "rooms": [
            {
              "roomType": "Standard" | "Deluxe" | "Family Suite" | ...,
              "maxOccupancy": number,
              "singleOccupancy": number,
              "perPersonSharing": number,
              "triplePerPerson": number,
              "quadPerPerson": number,
              "singleSupplement": number,
              "childBrackets": [
                { "label": "0-3", "minAge": 0, "maxAge": 3, "mode": "free" | "pct" | "flat", "value": number, "sharingRule": "sharing_with_adults" | "own_room" | "any" }
              ]
            }
          ],
          "supplements": [
            { "name": "Christmas/NYE", "dates": [{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }], "amountPerPerson": number, "amountPerRoom": number, "currency": "USD" | "KES" | ... (omit to inherit rate list currency), "mandatory": true }
          ]
        }
      ],
      "addOns": [
        { "name": "Drinks Package", "unit": "per_person_per_day", "amount": number, "currency": "USD" | "KES" | ... (omit to inherit rate list currency), "optional": true }
      ],
      "passThroughFees": [
        { "name": "Mara Reserve Fee", "unit": "per_person_per_day", "currency": "USD",
          "flatAmount": number,
          "tieredRows": [
            { "adultCitizen": n, "adultResident": n, "adultNonResident": n, "childCitizen": n, "childResident": n, "childNonResident": n, "childMinAge": 9, "childMaxAge": 17, "validFrom": "YYYY-MM-DD", "validTo": "YYYY-MM-DD" }
          ],
          "mandatory": true }
      ],
      "cancellationTiers": [
        { "daysBefore": 60, "penaltyPct": 25 },
        { "daysBefore": 30, "penaltyPct": 50 }
      ]
    }
  ],
  "warnings": ["array of strings for ambiguities — e.g. 'Could not parse Easter supplement dates'"]
}

Rules:
- If the PDF has Rack + STO side by side, produce TWO rate lists (different audience).
- If the PDF has a separate Resident pricelist in local currency (KES, TZS, UGX), produce a rate list with audience=["resident"] and that currency.
- If a season has multiple disjoint date windows (e.g. High = Jan 1–10 + Jul 1–Aug 31 + Dec 18–31), put all ranges in dateRanges.
- WEEKDAY vs WEEKEND pricing: if the PDF has two price columns like "Friday, Saturday, Public Holidays" vs "Sunday to Thursday", emit TWO seasons covering the same date range — one with daysOfWeek=[5,6] labeled "Weekend", one with daysOfWeek=[0,1,2,3,4] labeled "Weekday". (0=Sun..6=Sat.) Each season has its own room pricing from the matching column. Omit daysOfWeek entirely when the PDF has only one set of rates for the period.
- PUBLIC HOLIDAYS: if the weekend column explicitly includes "Public Holidays" (e.g. "Friday, Saturday, Public Holidays"), add the country's fixed-date public holidays to the Weekend season's specificDates array for the year(s) the rate list covers. For Kenya: Jan 1 (New Year), May 1 (Labour), Jun 1 (Madaraka), Oct 10 (Huduma), Oct 20 (Mashujaa), Dec 12 (Jamhuri), Dec 25 (Christmas), Dec 26 (Boxing). Skip Easter, Eid, and Diyas — they move each year and operators can add them manually.
- "Per person sharing" and "pp sharing" and "Per person in double" all mean perPersonSharing.
- Parse child policy into brackets. Free ages → mode="free". % of adult → mode="pct". Absolute amount → mode="flat".
- CURRENCY ON SUPPLEMENTS AND ADD-ONS: if the PDF states a supplement OR add-on in a different currency than the main rates (e.g. "US$40" Christmas supplement or "USD 250 per day" vehicle hire on a KES rate card), set that item's currency field to its explicit currency (USD). If the PDF gives the amount without a currency symbol, inherit the rate list currency and omit the field.
- Park fees, community fees, and government levies go in passThroughFees, NOT in nightly pricing.
- FLAT vs TIERED pass-through fees: if the PDF publishes ONE fee that everyone pays regardless of nationality (common for private conservancies — Chui/Oserengoni, Ol Pejeta day visits, etc.), populate a single tieredRows entry with the SAME value in adultCitizen, adultResident, AND adultNonResident (and the same for child fields). Do not leave any nationality column at zero — the resolver picks by the quote's nationality, and a zero means "this guest doesn't pay" which is almost never true. Use distinct values per column only when the PDF itself shows different prices by nationality (Mara Reserve Fee, SENAPA, MMNR).
- Drinks packages, vehicle hire, massages go in addOns.
- If a value isn't present in the PDF, omit the field or set it to 0 — don't invent numbers.
- All monetary values as bare numbers (no currency symbols, no commas).
- All dates as YYYY-MM-DD.`;

      const userText = [
        'Extract the hotel rate card from this PDF into the JSON schema above.',
        knownDestination ? `The operator says this hotel is in: ${knownDestination}.` : '',
        'Respond with ONLY the JSON object — no preamble.',
      ].filter(Boolean).join(' ');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
              { type: 'text', text: userText },
            ],
          }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return res.status(502).json({ message: `Claude error: ${errText.slice(0, 300)}` });
      }

      const data = await response.json();
      const raw = data.content?.[0]?.text || '';
      const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start === -1 || end === -1) {
        return res.status(422).json({ message: 'Claude returned non-JSON response', raw: raw.slice(0, 500) });
      }
      let parsed;
      try {
        parsed = JSON.parse(cleaned.substring(start, end + 1));
      } catch (e) {
        return res.status(422).json({ message: 'Claude JSON parse failed', detail: e.message, raw: raw.slice(0, 500) });
      }

      res.json({ draft: parsed });
    } catch (error) {
      console.error('PDF extract error:', error);
      res.status(500).json({ message: error.message });
    }
  });

router.delete('/hotels/:id', protect, async (req, res) => {
  try {
    await Hotel.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { isActive: false }
    );
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── TRANSPORT ────────────────────────────────────────

router.get('/transport', protect, async (req, res) => {
  try {
    const filter = { organization: req.organizationId, isActive: true };
    const transport = await Transport.find(filter).sort({ name: 1 });
    res.json({ transport, total: transport.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/transport', protect, requirePartnerQuota('transport'), enforceImageCap, async (req, res) => {
  try {
    const t = await Transport.create({ ...req.body, organization: req.organizationId });
    res.status(201).json(t);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/transport/:id', protect, enforceImageCap, async (req, res) => {
  try {
    const t = await Transport.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true }
    );
    if (!t) return res.status(404).json({ message: 'Not found' });
    res.json(t);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/transport/:id', protect, async (req, res) => {
  try {
    await Transport.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { isActive: false }
    );
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── ACTIVITIES ────────────────────────────────────────

router.get('/activities', protect, async (req, res) => {
  try {
    const { destination } = req.query;
    const filter = { organization: req.organizationId, isActive: true };
    if (destination) filter.destination = new RegExp(destination, 'i');
    
    const activities = await Activity.find(filter).sort({ destination: 1, name: 1 });
    res.json({ activities, total: activities.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/activities', protect, requirePartnerQuota('activity'), enforceImageCap, async (req, res) => {
  try {
    const a = await Activity.create({ ...req.body, organization: req.organizationId });
    res.status(201).json(a);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/activities/:id', protect, enforceImageCap, async (req, res) => {
  try {
    const a = await Activity.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true }
    );
    if (!a) return res.status(404).json({ message: 'Not found' });
    res.json(a);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/activities/:id', protect, async (req, res) => {
  try {
    await Activity.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { isActive: false }
    );
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── PACKAGES ──────────────────────────────────────────
// Multi-camp/multi-day trails with pax-tiered pricing (e.g. Maasai Trails).

router.get('/packages', protect, async (req, res) => {
  try {
    const { destination } = req.query;
    const filter = { organization: req.organizationId, isActive: true };
    if (destination) filter.destination = new RegExp(destination, 'i');
    const packages = await Package.find(filter).sort({ name: 1 });
    res.json({ packages, total: packages.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/packages/:id', protect, async (req, res) => {
  try {
    const pkg = await Package.findOne({ _id: req.params.id, organization: req.organizationId })
      .populate('segments.hotel', 'name images description');
    if (!pkg) return res.status(404).json({ message: 'Not found' });
    res.json(pkg);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/packages', protect, enforceImageCap, async (req, res) => {
  try {
    const pkg = await Package.create({ ...req.body, organization: req.organizationId });
    res.status(201).json(pkg);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/packages/:id', protect, enforceImageCap, async (req, res) => {
  try {
    const pkg = await Package.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!pkg) return res.status(404).json({ message: 'Not found' });
    res.json(pkg);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/packages/:id', protect, async (req, res) => {
  try {
    await Package.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { isActive: false }
    );
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Price a package for a given party. Picks the matching pax tier, applies
// child brackets + single supplement, returns a breakdown in both source
// and quote currency. Unlike hotels, a package is priced once per trip
// (not per night), so this returns a trip-level total.
router.post('/packages/:id/price', protect, async (req, res) => {
  try {
    const pkg = await Package.findOne({ _id: req.params.id, organization: req.organizationId }).lean();
    if (!pkg) return res.status(404).json({ message: 'Not found' });

    const { adults = 2, childAges = [], quoteCurrency, clientType } = req.body;
    const { convert } = await import('../utils/fx.js');

    const effectiveCurrency = quoteCurrency || req.organization?.defaults?.currency || 'USD';
    const orgFxOverrides = req.organization?.fxRates || {};

    const pricing = pkg.pricing || {};
    // Audience check — warn but don't block.
    const warnings = [];
    if (clientType && pricing.audience?.length && !pricing.audience.includes(clientType)) {
      warnings.push(`Package pricing is for audience=${pricing.audience.join('/')}; selected clientType=${clientType}`);
    }

    const totalPax = Number(adults) + (childAges?.length || 0);
    const tier = (pricing.paxTiers || []).find(t => totalPax >= (t.minPax || 1) && totalPax <= (t.maxPax || 99));
    if (!tier) {
      return res.json({ ok: false, reason: 'no_matching_pax_tier', totalPax, tiers: pricing.paxTiers, warnings });
    }

    const adultTotal = tier.pricePerPerson * adults;
    const singleSupplement = (adults === 1 ? (pricing.singleSupplement || 0) : 0);
    const childrenBreakdown = [];
    let childTotal = 0;
    for (const age of childAges) {
      const bracket = (pricing.childBrackets || []).find(b => age >= (b.minAge ?? 0) && age <= (b.maxAge ?? 17));
      if (!bracket || bracket.mode === 'free') {
        childrenBreakdown.push({ age, mode: 'free', amount: 0 });
        continue;
      }
      const amount = bracket.mode === 'flat'
        ? (bracket.value || 0)
        : tier.pricePerPerson * (bracket.value || 0) / 100;
      childTotal += amount;
      childrenBreakdown.push({ age, mode: bracket.mode, bracketLabel: bracket.label, amount });
    }

    const subtotalSource = adultTotal + singleSupplement + childTotal;
    const fxRate = (await import('../utils/fx.js')).getFxRate(pricing.currency, effectiveCurrency, orgFxOverrides) ?? 1;

    res.json({
      ok: true,
      package: { _id: pkg._id, name: pkg.name, durationNights: pkg.durationNights, durationDays: pkg.durationDays },
      tier,
      adults,
      childAges,
      adultTotal,
      singleSupplement,
      childTotal,
      childrenBreakdown,
      sourceCurrency: pricing.currency,
      quoteCurrency: effectiveCurrency,
      fxRate,
      subtotalSource,
      subtotalInQuoteCurrency: subtotalSource * fxRate,
      inclusions: pricing.inclusions || [],
      exclusions: pricing.exclusions || [],
      segments: pkg.segments || [],
      cancellationTiers: pkg.cancellationTiers || [],
      depositPct: pkg.depositPct || 0,
      bookingTerms: pkg.bookingTerms || '',
      warnings,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── SPREADSHEET IMPORT ────────────────────────────────
// Import format for hotels is multi-sheet:
//   Hotels — one row per (hotel, rate list, season, room type). Rows with the
//     same Name+Destination accumulate rate lists; same ListName accumulates
//     seasons; same SeasonLabel accumulates rooms.
//   PassThroughFees, AddOns, CancellationTiers, FeeTiers — keyed to hotel+list
//     (and, for fee tiers, to the fee name). All optional.
// Transport / Activities sheets retain their flat shape.

// Parse "0-3:free:0;4-11:pct:50;12-17:flat:80" into child bracket objects.
function parseChildBrackets(str) {
  if (!str) return [];
  return String(str).split(/[;|]/).map(s => s.trim()).filter(Boolean).map(part => {
    // format: "minAge-maxAge:mode:value[:sharingRule]"
    const [ages, mode, value, sharingRule] = part.split(':').map(s => s.trim());
    const [minAge, maxAge] = (ages || '').split('-').map(n => parseInt(n, 10));
    return {
      label: ages || '',
      minAge: isNaN(minAge) ? 0 : minAge,
      maxAge: isNaN(maxAge) ? 17 : maxAge,
      mode: ['free', 'pct', 'flat'].includes(mode) ? mode : 'pct',
      value: parseFloat(value) || 0,
      sharingRule: sharingRule || 'sharing_with_adults',
    };
  });
}

// Parse season date ranges: "2026-01-01..2026-03-31;2026-12-18..2026-12-31"
function parseDateRanges(str) {
  if (!str) return [];
  return String(str).split(/[;|]/).map(s => s.trim()).filter(Boolean).map(part => {
    const [from, to] = part.split('..').map(s => s.trim());
    return { from: from ? new Date(from) : null, to: to ? new Date(to) : null };
  }).filter(r => r.from && r.to && !isNaN(r.from.getTime()) && !isNaN(r.to.getTime()));
}

// Collect `HotelName` + `Destination` + `ListName` rows from an optional sheet.
// Returns a Map keyed by `${name}|${dest}|${list}` -> array of rows.
function indexByList(sheetData) {
  const out = new Map();
  for (const row of (sheetData || [])) {
    const key = `${row.HotelName}|${row.Destination}|${row.ListName}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

router.post('/import', protect, upload.single('file'), enforceCsvRowCap(xlsxRowCounter), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const results = { hotels: 0, rateLists: 0, transport: 0, activities: 0, destinations: 0, errors: [] };
    const seenDestinations = new Set();

    // Grab the side sheets up front
    const sheetLookup = {};
    for (const sheetName of workbook.SheetNames) {
      sheetLookup[sheetName.toLowerCase().replace(/\s+/g, '')] =
        XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    }
    const feesSheet = indexByList(sheetLookup.passthroughfees || sheetLookup.fees);
    const addOnsSheet = indexByList(sheetLookup.addons);
    const cancelSheet = indexByList(sheetLookup.cancellationtiers || sheetLookup.cancellation);
    const feeTiersSheet = sheetLookup.feetiers || [];

    for (const sheetName of workbook.SheetNames) {
      const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
      if (!data.length) continue;

      const type = sheetName.toLowerCase();

      if (type.includes('hotel') || type.includes('accommodation')) {
        // Group rows into nested maps: hotel -> list -> season -> rooms[]
        const hotelsMap = new Map();
        for (const row of data) {
          if (!row.Name || !row.Destination) continue;
          const hotelKey = `${row.Name}|${row.Destination}`;
          if (!hotelsMap.has(hotelKey)) {
            hotelsMap.set(hotelKey, {
              meta: {
                name: row.Name,
                destination: row.Destination,
                location: row.Location || '',
                stars: row.Stars || 3,
                type: (row.Type || 'hotel').toLowerCase(),
                currency: row.Currency || 'USD',
                description: row.Description || '',
                amenities: row.Amenities ? String(row.Amenities).split(',').map(s => s.trim()) : [],
                tags: row.Tags ? String(row.Tags).split(',').map(s => s.trim()) : [],
                notes: row.Notes || '',
                contactEmail: row.ContactEmail || '',
                contactPhone: row.ContactPhone || '',
              },
              lists: new Map(),
            });
          }
          const h = hotelsMap.get(hotelKey);

          const listName = row.ListName || 'Rack';
          if (!h.lists.has(listName)) {
            h.lists.set(listName, {
              meta: {
                name: listName,
                audience: row.ListAudience ? String(row.ListAudience).split(',').map(s => s.trim()) : ['retail'],
                currency: row.ListCurrency || row.Currency || 'USD',
                validFrom: row.ListValidFrom ? new Date(row.ListValidFrom) : null,
                validTo: row.ListValidTo ? new Date(row.ListValidTo) : null,
                priority: parseInt(row.ListPriority, 10) || 0,
                mealPlan: row.ListMealPlan || 'FB',
                mealPlanLabel: row.ListMealPlanLabel || '',
                depositPct: parseInt(row.ListDepositPct, 10) || 0,
                bookingTerms: row.ListBookingTerms || '',
                notes: row.ListNotes || '',
              },
              seasons: new Map(),
            });
          }
          const l = h.lists.get(listName);

          const seasonLabel = row.SeasonLabel || 'All Year';
          if (!l.seasons.has(seasonLabel)) {
            const dateRanges = [];
            // Support either SeasonDateRanges (multi-range string) or numbered columns
            if (row.SeasonDateRanges) {
              dateRanges.push(...parseDateRanges(row.SeasonDateRanges));
            } else {
              for (let i = 1; i <= 5; i++) {
                const from = row[`SeasonStart${i}`];
                const to = row[`SeasonEnd${i}`];
                if (from && to) dateRanges.push({ from: new Date(from), to: new Date(to) });
              }
            }
            const daysOfWeek = row.DaysOfWeek
              ? String(row.DaysOfWeek).split(',').map(s => parseInt(s.trim(), 10)).filter(n => n >= 0 && n <= 6)
              : [];
            const specificDates = row.SpecificDates
              ? String(row.SpecificDates).split(/[;,]/).map(s => s.trim()).filter(Boolean).map(d => new Date(d)).filter(d => !isNaN(d.getTime()))
              : [];
            l.seasons.set(seasonLabel, {
              label: seasonLabel,
              dateRanges,
              daysOfWeek,
              specificDates,
              minNights: parseInt(row.MinNights, 10) || 1,
              rooms: [],
              supplements: [],
            });
          }
          const s = l.seasons.get(seasonLabel);

          if (row.RoomType) {
            s.rooms.push({
              roomType: row.RoomType,
              maxOccupancy: parseInt(row.MaxOccupancy, 10) || 2,
              singleOccupancy: parseFloat(row.SingleOccupancy) || 0,
              perPersonSharing: parseFloat(row.PerPersonSharing) || 0,
              triplePerPerson: parseFloat(row.TriplePerPerson) || 0,
              quadPerPerson: parseFloat(row.QuadPerPerson) || 0,
              singleSupplement: parseFloat(row.SingleSupplement) || 0,
              childBrackets: parseChildBrackets(row.ChildBrackets),
              notes: row.RoomNotes || '',
            });
          }
        }

        // Upsert each hotel
        for (const [, hotelEntry] of hotelsMap) {
          try {
            const { meta, lists } = hotelEntry;

            if (meta.destination && !seenDestinations.has(meta.destination)) {
              seenDestinations.add(meta.destination);
              const existing = await Destination.findOne({
                organization: req.organizationId,
                name: { $regex: new RegExp(`^${meta.destination}$`, 'i') },
              });
              if (!existing) {
                await Destination.create({
                  organization: req.organizationId,
                  name: meta.destination,
                  country: 'Kenya',
                });
                results.destinations++;
              }
            }

            // Materialize rate lists with their side-sheet data
            const rateLists = [];
            for (const [, listEntry] of lists) {
              const { meta: lmeta, seasons } = listEntry;
              const key = `${meta.name}|${meta.destination}|${lmeta.name}`;

              const fees = (feesSheet.get(key) || []).map(fr => {
                // Collect tier rows by FeeName
                const tierRows = feeTiersSheet.filter(t =>
                  t.HotelName === meta.name && t.Destination === meta.destination &&
                  t.ListName === lmeta.name && t.FeeName === fr.FeeName
                ).map(t => ({
                  adultCitizen: parseFloat(t.AdultCitizen) || 0,
                  adultResident: parseFloat(t.AdultResident) || 0,
                  adultNonResident: parseFloat(t.AdultNonResident) || 0,
                  childCitizen: parseFloat(t.ChildCitizen) || 0,
                  childResident: parseFloat(t.ChildResident) || 0,
                  childNonResident: parseFloat(t.ChildNonResident) || 0,
                  childMinAge: parseInt(t.ChildMinAge, 10) || 0,
                  childMaxAge: parseInt(t.ChildMaxAge, 10) || 17,
                  validFrom: t.ValidFrom ? new Date(t.ValidFrom) : null,
                  validTo: t.ValidTo ? new Date(t.ValidTo) : null,
                  notes: t.Notes || '',
                }));
                return {
                  name: fr.FeeName,
                  unit: fr.Unit || 'per_person_per_day',
                  currency: fr.Currency || lmeta.currency,
                  flatAmount: parseFloat(fr.FlatAmount) || 0,
                  tieredRows: tierRows,
                  mandatory: String(fr.Mandatory || 'yes').toLowerCase() !== 'no',
                  notes: fr.Notes || '',
                };
              });

              const addOns = (addOnsSheet.get(key) || []).map(ar => ({
                name: ar.Name,
                description: ar.Description || '',
                unit: ar.Unit || 'per_person_per_day',
                amount: parseFloat(ar.Amount) || 0,
                optional: String(ar.Optional || 'yes').toLowerCase() !== 'no',
              }));

              const cancellation = (cancelSheet.get(key) || []).map(cr => ({
                daysBefore: parseInt(cr.DaysBefore, 10) || 0,
                penaltyPct: parseInt(cr.PenaltyPct, 10) || 0,
                notes: cr.Notes || '',
              }));

              rateLists.push({
                ...lmeta,
                seasons: Array.from(seasons.values()),
                passThroughFees: fees,
                addOns,
                cancellationTiers: cancellation,
                isActive: true,
              });
              results.rateLists++;
            }

            // Upsert: replace the hotel's rate lists wholesale (import is
            // authoritative). Preserve images/coordinates from any existing doc.
            const existing = await Hotel.findOne({
              organization: req.organizationId,
              name: meta.name,
              destination: meta.destination,
            });
            if (existing) {
              Object.assign(existing, meta, { rateLists });
              await existing.save();
            } else {
              await Hotel.create({
                organization: req.organizationId,
                ...meta,
                rateLists,
              });
            }
            results.hotels++;
          } catch (e) {
            results.errors.push(`Hotel "${hotelEntry.meta.name}": ${e.message}`);
          }
        }
      }

      if (type.includes('transport')) {
        for (const row of data) {
          try {
            await Transport.create({
              organization: req.organizationId,
              name: row.Name,
              type: (row.Type || '4x4').toLowerCase(),
              capacity: row.Capacity || 6,
              pricingModel: row.PricingModel || 'per_day',
              season: (row.Season || 'all').toLowerCase(),
              routeOrZone: row.RouteOrZone || '',
              rate: row.Rate || 0,
              fuelIncluded: row.FuelIncluded === 'yes',
              driverIncluded: row.DriverIncluded === 'yes',
              destinations: row.Destinations ? row.Destinations.split(',').map(d => d.trim()) : [],
              currency: row.Currency || 'KES',
              notes: row.Notes || '',
            });
            results.transport++;
          } catch (e) {
            results.errors.push(`Transport "${row.Name}": ${e.message}`);
          }
        }
      }

      if (type.includes('activit')) {
        for (const row of data) {
          try {
            // Auto-create destination
            if (row.Destination && !seenDestinations.has(row.Destination)) {
              seenDestinations.add(row.Destination);
              const existing = await Destination.findOne({
                organization: req.organizationId,
                name: { $regex: new RegExp(`^${row.Destination}$`, 'i') },
              });
              if (!existing) {
                await Destination.create({
                  organization: req.organizationId,
                  name: row.Destination,
                  country: 'Kenya',
                });
                results.destinations++;
              }
            }

            await Activity.create({
              organization: req.organizationId,
              name: row.Name,
              destination: row.Destination,
              description: row.Description || '',
              duration: row.Duration || 0,
              pricingModel: row.PricingModel || 'per_person',
              season: (row.Season || 'all').toLowerCase(),
              costPerPerson: row.CostPerPerson || 0,
              groupRate: row.GroupRate || 0,
              maxGroupSize: row.MaxGroupSize || 0,
              commissionRate: row.CommissionRate || 0,
              minimumAge: row.MinimumAge || 0,
              tags: row.Tags ? row.Tags.split(',').map(t => t.trim()) : [],
              currency: row.Currency || 'KES',
              notes: row.Notes || '',
            });
            results.activities++;
          } catch (e) {
            results.errors.push(`Activity "${row.Name}": ${e.message}`);
          }
        }
      }
    }

    res.json({
      message: `Imported ${results.hotels} hotels (${results.rateLists} rate lists), ${results.transport} transport, ${results.activities} activities${results.destinations > 0 ? `, ${results.destinations} new destinations` : ''}`,
      ...results,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Download a blank template with header rows + one example row per sheet.
router.get('/import/template', protect, async (req, res) => {
  const wb = XLSX.utils.book_new();

  const hotelsRows = [
    // First row = header; second = a filled example so operators see shape.
    {
      Name: 'Acacia Safari Lodge', Destination: 'Maasai Mara', Location: 'Talek',
      Stars: 4, Type: 'lodge', Currency: 'USD',
      Description: 'Luxury tented camp on the banks of the Talek River.',
      Amenities: 'Pool, WiFi, Bar, Restaurant', Tags: 'safari, luxury',
      ContactEmail: 'res@acaciasafari.com', ContactPhone: '+254700000000', Notes: '',
      ListName: 'Rack 2026', ListAudience: 'retail', ListCurrency: 'USD',
      ListValidFrom: '2026-01-01', ListValidTo: '2026-12-31', ListPriority: 0,
      ListMealPlan: 'FB', ListMealPlanLabel: 'Full Board', ListDepositPct: 30,
      ListBookingTerms: '', ListNotes: '',
      SeasonLabel: 'High', SeasonDateRanges: '2026-06-01..2026-10-31;2026-12-18..2026-12-31',
      DaysOfWeek: '', SpecificDates: '',
      MinNights: 2,
      RoomType: 'Standard Tent', MaxOccupancy: 2,
      SingleOccupancy: 500, PerPersonSharing: 380, TriplePerPerson: 340, QuadPerPerson: 300,
      SingleSupplement: 0,
      ChildBrackets: '0-3:free:0;4-11:pct:50;12-17:pct:75',
      RoomNotes: '',
    },
    // Weekend/weekday split example — two seasons covering the same dates
    // but different DaysOfWeek. 0=Sun..6=Sat.
    {
      Name: 'Chui Lodge', Destination: 'Naivasha', Location: 'Oserengoni',
      Stars: 5, Type: 'lodge', Currency: 'KES',
      Description: 'Luxury lodge in Oserengoni Wildlife Conservancy.',
      Amenities: '', Tags: 'safari, luxury', Notes: '',
      ContactEmail: 'reservations@oseriantwolakes.com', ContactPhone: '',
      ListName: 'Rack 2026', ListAudience: 'retail', ListCurrency: 'KES',
      ListValidFrom: '2026-01-01', ListValidTo: '2026-12-31', ListPriority: 0,
      ListMealPlan: 'FB', ListMealPlanLabel: 'Full Board', ListDepositPct: 30,
      ListBookingTerms: '', ListNotes: '',
      SeasonLabel: 'Weekend', SeasonDateRanges: '2026-01-01..2026-12-31', DaysOfWeek: '5,6', SpecificDates: '2026-01-01;2026-05-01;2026-06-01;2026-10-20;2026-12-12;2026-12-25;2026-12-26',
      MinNights: 1,
      RoomType: 'Standard Room', MaxOccupancy: 2,
      SingleOccupancy: 47700, PerPersonSharing: 37000, TriplePerPerson: 0, QuadPerPerson: 0,
      SingleSupplement: 0,
      ChildBrackets: '0-2:free:0;3-11:flat:18500',
      RoomNotes: '',
    },
    {
      Name: 'Chui Lodge', Destination: 'Naivasha', Location: 'Oserengoni',
      Stars: 5, Type: 'lodge', Currency: 'KES',
      Description: '', Amenities: '', Tags: '', Notes: '', ContactEmail: '', ContactPhone: '',
      ListName: 'Rack 2026', ListAudience: 'retail', ListCurrency: 'KES',
      ListValidFrom: '2026-01-01', ListValidTo: '2026-12-31', ListPriority: 0,
      ListMealPlan: 'FB', ListMealPlanLabel: 'Full Board', ListDepositPct: 30,
      ListBookingTerms: '', ListNotes: '',
      SeasonLabel: 'Weekday', SeasonDateRanges: '2026-01-01..2026-12-31', DaysOfWeek: '0,1,2,3,4', SpecificDates: '',
      MinNights: 1,
      RoomType: 'Standard Room', MaxOccupancy: 2,
      SingleOccupancy: 41300, PerPersonSharing: 32400, TriplePerPerson: 0, QuadPerPerson: 0,
      SingleSupplement: 0,
      ChildBrackets: '0-2:free:0;3-11:flat:16200',
      RoomNotes: '',
    },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(hotelsRows), 'Hotels');

  // Side sheets — one example row each, operators can delete/extend.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{
    HotelName: 'Acacia Safari Lodge', Destination: 'Maasai Mara', ListName: 'Rack 2026',
    FeeName: 'Mara Reserve Fee', Unit: 'per_person_per_day', Currency: 'USD',
    FlatAmount: 0, Mandatory: 'yes', Notes: 'Separate fee, payable to MMNR',
  }]), 'PassThroughFees');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{
    HotelName: 'Acacia Safari Lodge', Destination: 'Maasai Mara', ListName: 'Rack 2026',
    FeeName: 'Mara Reserve Fee',
    AdultCitizen: 1500, AdultResident: 1500, AdultNonResident: 100,
    ChildCitizen: 300, ChildResident: 300, ChildNonResident: 40,
    ChildMinAge: 9, ChildMaxAge: 17,
    ValidFrom: '2026-07-01', ValidTo: '2026-12-31', Notes: '',
  }]), 'FeeTiers');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{
    HotelName: 'Acacia Safari Lodge', Destination: 'Maasai Mara', ListName: 'Rack 2026',
    Name: 'Drinks Package', Description: 'House beer, wine, spirits',
    Unit: 'per_person_per_day', Amount: 40, Optional: 'yes',
  }]), 'AddOns');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { HotelName: 'Acacia Safari Lodge', Destination: 'Maasai Mara', ListName: 'Rack 2026', DaysBefore: 60, PenaltyPct: 25, Notes: '' },
    { HotelName: 'Acacia Safari Lodge', Destination: 'Maasai Mara', ListName: 'Rack 2026', DaysBefore: 30, PenaltyPct: 50, Notes: '' },
    { HotelName: 'Acacia Safari Lodge', Destination: 'Maasai Mara', ListName: 'Rack 2026', DaysBefore: 14, PenaltyPct: 100, Notes: '' },
  ]), 'CancellationTiers');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{
    Name: 'Toyota Land Cruiser', Type: '4x4', Capacity: 7, PricingModel: 'per_day',
    Season: 'all', RouteOrZone: 'Nairobi to Maasai Mara', Rate: 350, Currency: 'USD',
    FuelIncluded: 'yes', DriverIncluded: 'yes', Destinations: 'Maasai Mara, Nairobi', Notes: '',
  }]), 'Transport');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{
    Name: 'Hot Air Balloon Safari', Destination: 'Maasai Mara',
    Description: 'Sunrise balloon flight with champagne breakfast',
    Duration: 4, PricingModel: 'per_person', CostPerPerson: 480,
    MaxGroupSize: 16, MinimumAge: 7, Currency: 'USD', Tags: 'adventure, romance', Notes: '',
  }]), 'Activities');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="safiripro-import-template.xlsx"');
  res.send(buf);
});

// ─── STATS ────────────────────────────────────────

router.get('/stats', protect, async (req, res) => {
  try {
    const orgId = req.organizationId;
    const [hotels, transport, activities] = await Promise.all([
      Hotel.countDocuments({ organization: orgId, isActive: true }),
      Transport.countDocuments({ organization: orgId, isActive: true }),
      Activity.countDocuments({ organization: orgId, isActive: true }),
    ]);
    
    const destinations = await Hotel.distinct('destination', { organization: orgId, isActive: true });
    
    res.json({ hotels, transport, activities, destinations: destinations.length, destinationList: destinations });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;