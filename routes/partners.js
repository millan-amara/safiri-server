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
import { priceActivity } from '../services/activityPricer.js';
import { priceTransport } from '../services/transportPricer.js';
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

      const systemPrompt = `You extract hotel information into structured JSON for a safari-itinerary app.

The PDF can be ANY of these document types, or combinations of them:
  (a) A hotel rate card with nightly pricing tables (Chui, AA Lodges, Acacia).
  (b) A Terms & Conditions document with cancellation, deposit, payment policies.
  (c) A property info / fact sheet with description, amenities, bedroom count.
  (d) A multi-hotel chain document with several properties on one sheet.
  (e) A PACKAGE / TRAIL rate card — multi-camp mobile safaris priced as a whole trip (not per night) with pax tiers (1 pax / 2 pax / 3+ pax per person). Maasai Trails is the canonical example: named trails like "Through the Rift", "Great Rift Valley Walk", "Oltyiani Trail" that visit a sequence of camps over several nights.
  (f) A bundle combining any of the above.

Extract WHATEVER is present. Do NOT fail or return empty if rate tables are missing. Fields you cannot populate should be omitted (not set to empty strings or zero).

Return two top-level arrays: "hotels" for nightly-priced lodges, "packages" for trip-priced multi-camp trails. Either can be empty. Shared Terms & Policies apply to every record in the document — duplicate them across each.

HOTEL vs PACKAGE decision rule:
  - If the document prices per night / per person per night / per room per night → HOTEL.
  - If the document prices per whole trip / per person for a named trail of N nights → PACKAGE.
  - If a "2-night extension" or similar ambiguous product appears alongside packages, treat as a package with durationNights=2.

You MUST respond with ONLY valid JSON — no markdown, no commentary. The top-level shape is:
{
  "hotels": [HotelObject, ...],
  "packages": [PackageObject, ...],
  "warnings": ["array of strings flagging ambiguities"]
}

PackageObject schema:
{
  "name": "Through the Rift",
  "destination": "Loita Hills" | "Kenya + Tanzania" | ...,
  "description": "3-night walking safari through Rift Valley camps",
  "durationNights": 3,
  "durationDays": 4,
  "segments": [
    { "startDay": 1, "endDay": 1, "location": "River Camp", "hotelName": "River Camp" },
    { "startDay": 2, "endDay": 2, "location": "Oltyiani", "hotelName": "Oltyiani" },
    { "startDay": 3, "endDay": 3, "location": "Ngurumans", "hotelName": "Ngurumans" }
  ],
  "pricingLists": [
    {
      "name": "Rack 2026",
      "audience": ["retail"],
      "currency": "USD",
      "validFrom": "2026-01-01",
      "validTo": "2026-12-31",
      "priority": 0,
      "paxTiers": [
        { "minPax": 1, "maxPax": 1, "pricePerPerson": 2935 },
        { "minPax": 2, "maxPax": 2, "pricePerPerson": 2602 },
        { "minPax": 3, "maxPax": 99, "pricePerPerson": 1947 }
      ],
      "singleSupplement": 0,
      "childBrackets": [
        { "label": "under 16", "minAge": 0, "maxAge": 15, "mode": "pct", "value": 75, "sharingRule": "any" }
      ],
      "mealPlan": "FB",
      "mealPlanLabel": "Full Board",
      "inclusions": ["Full board accommodation", "All drinks except premium", "All safari equipment", "Guides and staff"],
      "exclusions": ["Emergency evacuation cover", "Flights", "Vehicle transfers", "Gratuities"]
    }
  ],
  "cancellationTiers": [{ "daysBefore": 60, "penaltyPct": 25 }],
  "depositPct": 30,
  "bookingTerms": "..."
}

Each HotelObject follows this schema:
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
              "pricingMode": "per_person" | "per_room_total",
              "singleOccupancy": number,
              "perPersonSharing": number,
              "triplePerPerson": number,
              "quadPerPerson": number,
              "singleSupplement": number,
              "childBrackets": [
                { "label": "0-3", "minAge": 0, "maxAge": 3, "mode": "free" | "pct" | "flat", "value": number, "sharingRule": "sharing_with_adults" | "own_room" | "any" }
              ],
              "stayTiers": [
                { "minNights": 1, "maxNights": 3, "singleOccupancy": number, "perPersonSharing": number, "triplePerPerson": number, "quadPerPerson": number, "singleSupplement": number },
                { "minNights": 4, "maxNights": 6, "singleOccupancy": number, "perPersonSharing": number, "triplePerPerson": number, "quadPerPerson": number, "singleSupplement": number },
                { "minNights": 7, "singleOccupancy": number, "perPersonSharing": number, "triplePerPerson": number, "quadPerPerson": number, "singleSupplement": number }
              ]
            }
          ],
          "supplements": [
            { "name": "Christmas/NYE", "dates": [{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }], "amountPerPerson": number (per adult), "amountPerChild": number (per child, 0 = exempt), "amountPerRoom": number, "currency": "USD" | "KES" | ... (omit to inherit rate list currency), "mandatory": true }
          ]
        }
      ],
      "addOns": [
        { "name": "Drinks Package", "unit": "per_person_per_day" | "per_day" | "per_trip" | "per_person" | "per_room_per_day" | "per_vehicle", "amount": number, "currency": "USD" | "KES" | ... (omit to inherit rate list currency), "optional": true }
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
      ],
      "inclusions": ["Full-board - all meals & accommodation", "Soft drinks, local beers, house wines", "Shared game drives", "VAT & taxes"],
      "exclusions": ["Daily conservation fees", "Premium spirits, wines, Champagne", "Massages & treatments", "Gratuities to staff & guides"]
    }
  ]
}
Rules:
- If the PDF has Rack + STO side by side, produce TWO rate lists (different audience).
- If the PDF has a separate Resident pricelist in local currency (KES, TZS, UGX), produce a rate list with audience=["resident"] and that currency.
- If a season has multiple disjoint date windows (e.g. High = Jan 1–10 + Jul 1–Aug 31 + Dec 18–31), put all ranges in dateRanges.
- WEEKDAY vs WEEKEND pricing: if the PDF has two price columns like "Friday, Saturday, Public Holidays" vs "Sunday to Thursday", emit TWO seasons covering the same date range — one with daysOfWeek=[5,6] labeled "Weekend", one with daysOfWeek=[0,1,2,3,4] labeled "Weekday". (0=Sun..6=Sat.) Each season has its own room pricing from the matching column. Omit daysOfWeek entirely when the PDF has only one set of rates for the period.
- PUBLIC HOLIDAYS: if the weekend column explicitly includes "Public Holidays" (e.g. "Friday, Saturday, Public Holidays"), add the country's fixed-date public holidays to the Weekend season's specificDates array for the year(s) the rate list covers. For Kenya: Jan 1 (New Year), May 1 (Labour), Jun 1 (Madaraka), Oct 10 (Huduma), Oct 20 (Mashujaa), Dec 12 (Jamhuri), Dec 25 (Christmas), Dec 26 (Boxing). Skip Easter, Eid, and Diyas — they move each year and operators can add them manually.
- "Per person sharing" and "pp sharing" and "Per person in double" all mean perPersonSharing with pricingMode="per_person".
- PRICING MODE detection — critical: some PDFs publish per-person rates ("USD 675 per person per night"), others publish TOTAL ROOM rates per column (Single/Twin-Double/Triple as columns of absolute room totals). Detect this by:
  (a) Explicit wording ("per person", "pp", "pax" → per_person; "per room", "total", no per-person marker → per_room_total).
  (b) Math check: if the Double number is less than 2× the Single number, it is almost certainly per_room_total (otherwise sharing would cost more than solo, which is nonsense). AA Lodges agent rate cards, many Kenyan contract sheets, and most resident pricelists use per_room_total — columns labeled SINGLE / TWIN/DOUBLE / TRIPLE without a "per person" header typically mean total per room.
  Set pricingMode on EACH roomPricing entry. Default "per_person" only when you are genuinely sure; otherwise flag in warnings.
- Parse child policy into brackets. Free ages → mode="free". % of adult → mode="pct". Absolute amount → mode="flat".
- WHERE TO FIND CHILD POLICY: scan the ENTIRE document. If the PDF has a combined rate-card + Terms & Policies layout (AA Lodges, Serena, Sarova), the Child Policy is usually in a numbered section on a later page ("4. Child Policy", "Children Rates", etc.), NOT in the rate tables. When found there, duplicate the parsed brackets into EVERY room of EVERY season of EVERY rate list you return — the policy applies to all properties and audiences uniformly. Common AA-Lodges-style parsing:
    * "Up to 3 years sharing with adult/s - No Charge" → { minAge: 0, maxAge: 3, mode: "free", sharingRule: "sharing_with_adults" }
    * "Over 3 up to 12 years sharing with 1 or 2 adults - 50% of applicable per person adult double room rate" → { minAge: 4, maxAge: 12, mode: "pct", value: 50, sharingRule: "sharing_with_adults" }
    * "Over 12 up to 16 years sharing with 1 or 2 adults - 75%" → { minAge: 13, maxAge: 16, mode: "pct", value: 75, sharingRule: "sharing_with_adults" }
    * "Up to 16 years having exclusive use of room - 75% of full adult single/double/triple rate" → { minAge: 0, maxAge: 16, mode: "pct", value: 75, sharingRule: "own_room" }
- SAME FOR CANCELLATION / DEPOSIT / PAYMENT TERMS: if the document has a separate Terms & Policies section, parse Cancellation and No-Shows into cancellationTiers, the deposit clause into depositPct, and the payment/jurisdiction clauses into bookingTerms. Duplicate across every hotel/rate list in the document.
- CURRENCY ON SUPPLEMENTS AND ADD-ONS: if the PDF states a supplement OR add-on in a different currency than the main rates (e.g. "US$40" Christmas supplement or "USD 250 per day" vehicle hire on a KES rate card), set that item's currency field to its explicit currency (USD). If the PDF gives the amount without a currency symbol, inherit the rate list currency and omit the field.
- CHILD SUPPLEMENTS: supplements have amountPerPerson (adult) and amountPerChild (child). If the PDF says "per adult, half price for children" ($40 adult / $20 child), set amountPerPerson=40 and amountPerChild=20. If the PDF says "per person" without distinction, set both equal. If the PDF says children are exempt, set amountPerChild=0. Do not leave amountPerChild unset when the PDF specifies child pricing.
- Park fees, community fees, and government levies go in passThroughFees, NOT in nightly pricing.
- INCLUSIONS and EXCLUSIONS: every supplier PDF has an INCLUDED and EXCLUDED section (Chui, Spekes, Acacia all do). Extract each bullet as a string into the "inclusions" / "exclusions" arrays on the rate list. Keep each item short and client-readable. Items priced as add-ons in the excluded section ("Extra lunch pp USD 40", "Land Cruiser USD 250/day") should appear in BOTH the "exclusions" array (so the client sees it is not included) AND in the "addOns" array (structured so the quote builder can offer them).
- FLAT vs TIERED pass-through fees: if the PDF publishes ONE fee that everyone pays regardless of nationality (common for private conservancies — Chui/Oserengoni, Ol Pejeta day visits, etc.), populate a single tieredRows entry with the SAME value in adultCitizen, adultResident, AND adultNonResident (and the same for child fields). Do not leave any nationality column at zero — the resolver picks by the quote's nationality, and a zero means "this guest doesn't pay" which is almost never true. Use distinct values per column only when the PDF itself shows different prices by nationality (Mara Reserve Fee, SENAPA, MMNR).
- Drinks packages, vehicle hire, massages go in addOns.
- If a value isn't present in the PDF, omit the field or set it to 0 — don't invent numbers.
- All monetary values as bare numbers (no currency symbols, no commas).
- All dates as YYYY-MM-DD.
- MULTI-HOTEL DOCUMENTS: if the PDF has separate sections or tables for different properties (AA Lodge Masai Mara and AA Lodge Amboseli, Serena properties, etc.), return one HotelObject per property in the top-level "hotels" array. Shared Terms & Policies (cancellation, deposit, booking terms, inclusions) apply to all properties — copy them into each hotel's rateLists.
- INFO / FACT SHEETS without rate tables: when the PDF is a property description (e.g. a "Key Info" sheet with bedrooms, amenities, nearest-beach distance), extract "name", "destination", "location", "type", "description" (the marketing prose), and "amenities" (flatten every feature from Pool, General, Standard, Utilities, Outdoors, Access tables into a single amenities string array — skip trivia like furniture counts, wheelchair suitability, pet/smoking rules which don't belong on a client quote). Leave "rateLists" as an empty array. DO NOT invent rates.
- PACKAGE TRAIL EXTRACTION: when the PDF lists named multi-camp trails with whole-trip pricing (Maasai Trails, some Wilderness / Asilia walking safaris), emit one PackageObject per trail. Parse the camp sequence into segments (one per camp stay); pax-tier pricing tables into paxTiers; child policy ("Children under 16 pay 75%") into childBrackets; "Rack" vs "STO" vs "Resident" into separate pricingLists entries with the matching audience tag. Full-trip flat-price products ("Extension from the Mara: US$ 665 pp/day") also belong in packages — convert the per-day number into a single paxTier using (durationDays × rate) as pricePerPerson, OR leave pricing as a single tier with a note explaining the per-day structure.
- LENGTH-OF-STAY TIERS: some rate cards (A&K Sanctuary, several East-African lodges) publish different prices for the same room based on TOTAL nights stayed — e.g. "1-3 nights $900pp, 4-6 nights $720pp, 7+ nights $675pp". When you see this layout, emit each LoS band as an entry in the room's stayTiers array: minNights, maxNights (OMIT maxNights for open-ended bands like "7+"), singleOccupancy, perPersonSharing, triplePerPerson, quadPerPerson, singleSupplement. ALSO populate the room's top-level singleOccupancy/perPersonSharing/triplePerPerson/quadPerPerson with the SHORTEST-stay tier's values (so catalog "from" prices still work). Include the shortest tier in stayTiers too — do not skip it. Skip stayTiers entirely when the PDF has one price per room regardless of stay length.
- PER-VEHICLE TRANSFERS AND ACTIVITIES: road transfers and vehicle-hire activities priced "per vehicle" (e.g. "JKIA to Hotel $190 per vehicle (max 6)", "Exclusive use of vehicle $650 per vehicle per day") go in addOns with unit="per_vehicle". Do NOT coerce them to per_trip or per_person. If a price is "per vehicle per day" vs "per vehicle one way", add a short description noting which.
- PARK FEES BY LOCATION: when a document lists park/reserve fees for multiple regions (Manyara, Ngorongoro, Serengeti, Tarangire, Amboseli, Mara, Bwindi, etc.), attach each fee ONLY to the hotels physically located in or bordering that park/conservancy — do NOT duplicate every regional fee onto every hotel. Use the hotel's destination/location and any hints in the PDF (e.g. "Swala Camp is in Tarangire", "Kitirua Plains Lodge - Amboseli National Park Fees") to bind correctly. Conservancy/camping fees named alongside a specific camp go only on that camp. When unsure, attach to the likeliest hotel and add a warning.
- CHILD AGE BRACKETS — inclusive boundaries: "6 years old and younger" or "Up to 6 years" → minAge=0, maxAge=6. "Between 7-15 years old" → minAge=7, maxAge=15. "16 years old and older" → adult, create no bracket. A standalone "6 years old" line with "Free of charge" next to it is ambiguous — interpret as minAge=0, maxAge=6 and add a warning so the operator can confirm.
- UNUSUAL OCCUPANCY COLUMNS: when a PDF prices a suite/villa as "Per Suite (Max N)" with a separate "5th Adult Sharing" / "Nth Adult" column that's BEYOND the base max-occupancy, treat it as pricingMode="per_room_total", set maxOccupancy=N, and put the extra-adult rate in triplePerPerson ONLY if N=2 (standard triple-beyond-double). For larger suites (Max 4 with a 5th-adult column), put the 5th-adult amount in the room's notes field and add a warning — the schema has no native 5th-pax slot.
- TRIPLE-ONLY-FOR-CHILD CONSTRAINT: if the PDF restricts triple occupancy to families ("triples only if 3rd person is a child"), still encode triplePerPerson with the quoted dollar amount, and add a warning like "Camp X triple applies only when 3rd person is a child — enforce at booking time".
- DISCONTINUOUS VALIDITY: A single price row often covers multiple separate date windows ("03 January - 31 March | 01 - 15 June"). Emit ALL of those as separate entries in ONE season's dateRanges array — do NOT create multiple seasons when the prices are identical. Seasons with "Not Applicable" or a closure note should be omitted entirely from dateRanges for that period.`;

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
          // 64000 is Sonnet-4's max output. Multi-hotel docs (A&K East Africa:
          // 7 hotels × Rack+STO × LoS tiers × multi-season + pass-through fees)
          // blow past the 16000 we started with. Ceiling, not target — we pay
          // for actual usage only, so leaving headroom costs nothing.
          max_tokens: 64000,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
                { type: 'text', text: userText },
              ],
            },
            // Prefill forces Claude's response to start with "{" — no natural-language
            // preamble, no "Here is the JSON you requested:". The prefill is prepended
            // back before parsing.
            { role: 'assistant', content: '{' },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return res.status(502).json({ message: `Claude error: ${errText.slice(0, 300)}` });
      }

      const data = await response.json();
      const stopReason = data.stop_reason;
      // Reconstruct full JSON with the prefilled "{"
      const raw = '{' + (data.content?.[0]?.text || '');
      const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');

      if (start === -1 || end === -1) {
        console.error('[extract-pdf] Non-JSON response. stop_reason=%s raw=%s', stopReason, raw.slice(0, 800));
        return res.status(422).json({
          message: stopReason === 'max_tokens'
            ? 'The PDF is too dense and the extraction ran out of space. Try splitting the rate card into separate PDFs.'
            : 'Claude returned non-JSON response. Try again, or enter data manually.',
          stopReason,
        });
      }
      let parsed;
      try {
        parsed = JSON.parse(cleaned.substring(start, end + 1));
      } catch (e) {
        console.error('[extract-pdf] JSON parse failed. stop_reason=%s err=%s raw=%s', stopReason, e.message, raw.slice(0, 800));
        return res.status(422).json({
          message: stopReason === 'max_tokens'
            ? 'The PDF is too dense and the extraction was truncated mid-JSON. Try splitting the rate card into separate PDFs.'
            : 'Claude returned malformed JSON. Try again, or enter data manually.',
          stopReason,
          detail: e.message,
        });
      }

      // Normalize. Claude may return:
      //   { hotels: [...], packages: [...], warnings: [...] }  (current schema)
      //   { hotels: [...], warnings: [...] }                   (earlier schema)
      //   { ...singleHotel }                                   (legacy, rate-card PDFs)
      const hotels = Array.isArray(parsed?.hotels)
        ? parsed.hotels
        : (parsed && typeof parsed === 'object' && !parsed.packages ? [parsed] : []);
      const packages = Array.isArray(parsed?.packages) ? parsed.packages : [];
      const warnings = Array.isArray(parsed?.warnings) ? parsed.warnings : [];

      res.json({ drafts: hotels, packages, warnings });
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

// Price a transport for a quote: applies the pricingModel + FX. Mirrors
// /activities/:id/price so the client can snapshot FX context onto the day.
router.post('/transport/:id/price', protect, async (req, res) => {
  try {
    const transport = await Transport.findOne({ _id: req.params.id, organization: req.organizationId }).lean();
    if (!transport) return res.status(404).json({ message: 'Transport not found' });

    const { adults = 0, children = 0, days = 1, distanceKm = 0, quoteCurrency } = req.body;
    const effectiveCurrency = quoteCurrency || req.organization?.defaults?.currency || 'USD';
    const orgFxOverrides = req.organization?.fxRates || {};

    const priced = priceTransport(transport, {
      adults,
      children,
      days,
      distanceKm,
      quoteCurrency: effectiveCurrency,
      orgFxOverrides,
    });

    res.json({ ok: true, ...priced });
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

// Price an activity for a quote: applies the activity's pricingModel and
// converts from the activity's source currency into the quote's currency
// using the org's FX overrides. Mirrors /hotels/:id/price-stay so the client
// can snapshot FX context onto the day.activities[] entry.
router.post('/activities/:id/price', protect, async (req, res) => {
  try {
    const activity = await Activity.findOne({ _id: req.params.id, organization: req.organizationId }).lean();
    if (!activity) return res.status(404).json({ message: 'Activity not found' });

    const { adults = 0, children = 0, childAges = [], quoteCurrency } = req.body;
    const effectiveCurrency = quoteCurrency || req.organization?.defaults?.currency || 'USD';
    const orgFxOverrides = req.organization?.fxRates || {};

    const priced = priceActivity(activity, {
      adults,
      children,
      childAges,
      quoteCurrency: effectiveCurrency,
      orgFxOverrides,
    });

    res.json({ ok: true, ...priced });
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

// Merge new pricing lists into an existing package. Used by the PDF extraction
// flow when the operator uploads a second rate sheet (e.g. STO after Rack) for
// a package that already exists — we append only pricing lists whose `name`
// isn't already present, avoiding duplicates.
// Also fills cancellationTiers / bookingTerms / depositPct if the existing
// record has none (never clobbers operator-entered values).
// Same merge semantics for hotels: append rate lists by name, fill shared
// contract/policy fields only where the existing record is blank.
router.put('/hotels/:id/merge-rate-lists', protect, async (req, res) => {
  try {
    const hotel = await Hotel.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!hotel) return res.status(404).json({ message: 'Not found' });

    const {
      rateLists = [],
      description = '',
      amenities = [],
    } = req.body;

    const existingListNames = new Set((hotel.rateLists || []).map(l => l.name));
    const appended = [];
    for (const list of rateLists) {
      if (!list?.name || existingListNames.has(list.name)) continue;
      hotel.rateLists.push(list);
      existingListNames.add(list.name);
      appended.push(list.name);
    }

    if (!hotel.description && description) hotel.description = description;
    if ((!hotel.amenities?.length) && amenities.length) {
      hotel.amenities = amenities;
    } else if (amenities.length) {
      // Union dedup
      hotel.amenities = Array.from(new Set([...hotel.amenities, ...amenities]));
    }

    await hotel.save();
    res.json({ hotel, appendedListNames: appended });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/packages/:id/merge-pricing-lists', protect, async (req, res) => {
  try {
    const pkg = await Package.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!pkg) return res.status(404).json({ message: 'Not found' });

    const {
      pricingLists = [],
      cancellationTiers = [],
      bookingTerms = '',
      depositPct = 0,
      description = '',
    } = req.body;

    const existingListNames = new Set((pkg.pricingLists || []).map(l => l.name));
    const appended = [];
    for (const list of pricingLists) {
      if (!list?.name || existingListNames.has(list.name)) continue;
      pkg.pricingLists.push(list);
      existingListNames.add(list.name);
      appended.push(list.name);
    }

    // Only fill shared fields if the existing record leaves them blank.
    if (!pkg.cancellationTiers?.length && cancellationTiers.length) {
      pkg.cancellationTiers = cancellationTiers;
    }
    if (!pkg.bookingTerms && bookingTerms) pkg.bookingTerms = bookingTerms;
    if (!pkg.depositPct && depositPct) pkg.depositPct = depositPct;
    if (!pkg.description && description) pkg.description = description;

    await pkg.save();
    res.json({ package: pkg, appendedListNames: appended });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Price a package for a given party. Picks the matching pax tier, applies
// child brackets + single supplement, returns a breakdown in both source
// and quote currency. Unlike hotels, a package is priced once per trip
// (not per night), so this returns a trip-level total.
// Canonical audience tag expansions — same mapping the hotel resolver uses.
const PACKAGE_AUDIENCE_MATCH = {
  retail: ['retail', 'public', 'rack'],
  contract: ['contract', 'dmc', 'agent', 'sto', 'trade'],
  resident: ['resident', 'eac', 'citizen', 'local'],
};

function packageListMatchesAudience(list, clientType) {
  const accept = PACKAGE_AUDIENCE_MATCH[clientType] || [clientType];
  return (list.audience || []).some(tag => accept.includes(String(tag).toLowerCase()));
}

function packageListCoversDate(list, date) {
  const from = list.validFrom ? new Date(list.validFrom) : null;
  const to = list.validTo ? new Date(list.validTo) : null;
  const d = date ? new Date(date) : new Date();
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

router.post('/packages/:id/price', protect, async (req, res) => {
  try {
    const pkg = await Package.findOne({ _id: req.params.id, organization: req.organizationId }).lean();
    if (!pkg) return res.status(404).json({ message: 'Not found' });

    const {
      adults = 2,
      childAges = [],
      quoteCurrency,
      clientType = 'retail',
      startDate,
    } = req.body;
    const { convert, getFxRate } = await import('../utils/fx.js');

    const effectiveCurrency = quoteCurrency || req.organization?.defaults?.currency || 'USD';
    const orgFxOverrides = req.organization?.fxRates || {};
    const warnings = [];

    // ─── Pick the pricing list ─────────────────────────────────────────────
    const allLists = (pkg.pricingLists || []).filter(l => l.isActive !== false);
    if (allLists.length === 0) {
      return res.json({ ok: false, reason: 'no_pricing_lists', warnings });
    }

    let eligible = allLists.filter(l => packageListMatchesAudience(l, clientType));
    if (!eligible.length) {
      warnings.push(`No pricing list matches clientType=${clientType}. Falling back to any active list.`);
      eligible = allLists;
    }

    const dated = eligible.filter(l => packageListCoversDate(l, startDate));
    if (dated.length) eligible = dated;
    else if (startDate) warnings.push(`No pricing list covers start date ${startDate}. Using most recent.`);

    const pricing = eligible.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
    if (!pricing) {
      return res.json({ ok: false, reason: 'no_eligible_pricing_list', warnings });
    }

    // ─── Pax tier + child breakdown ────────────────────────────────────────
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
    const fxRate = getFxRate(pricing.currency, effectiveCurrency, orgFxOverrides) ?? 1;

    // Hydrate segment hotels — segment.hotel is just an ObjectId ref. Without
    // this the client builds package days with empty descriptions/images even
    // when the linked Hotel doc has full info. One bulk lookup so we don't
    // N+1 across 5–10 segment camps.
    const segmentHotelIds = (pkg.segments || [])
      .map(s => s.hotel)
      .filter(Boolean)
      .map(id => String(id));
    const hotelDocs = segmentHotelIds.length
      ? await Hotel.find({ _id: { $in: segmentHotelIds }, organization: req.organizationId })
          .select('name description images location destination type stars amenities contactEmail contactPhone coordinates tags')
          .lean()
      : [];
    const hotelById = new Map(hotelDocs.map(h => [String(h._id), h]));
    const populatedSegments = (pkg.segments || []).map(seg => {
      const linked = seg.hotel ? hotelById.get(String(seg.hotel)) : null;
      return {
        startDay: seg.startDay,
        endDay: seg.endDay,
        location: seg.location,
        notes: seg.notes,
        // Carry the ref id alongside the resolved doc so the client can use
        // it for follow-on actions (e.g. opening the hotel partner page).
        hotelId: linked ? linked._id : seg.hotel || null,
        hotelName: linked?.name || seg.hotelName || '',
        hotel: linked || null,
      };
    });

    res.json({
      ok: true,
      package: {
        _id: pkg._id,
        name: pkg.name,
        description: pkg.description || '',
        durationNights: pkg.durationNights,
        durationDays: pkg.durationDays,
        images: pkg.images || [],
        tags: pkg.tags || [],
        notes: pkg.notes || '',
      },
      pricingList: {
        _id: pricing._id,
        name: pricing.name,
        audience: pricing.audience,
        priority: pricing.priority,
        mealPlan: pricing.mealPlan,
        mealPlanLabel: pricing.mealPlanLabel || '',
        seasonLabel: pricing.seasonLabel || '',
        notes: pricing.notes || '',
      },
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
      segments: populatedSegments,
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