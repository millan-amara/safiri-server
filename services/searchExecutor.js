// Deterministic search executor.
//
// Given a parsed query (from searchParser) and an organizationId, runs the
// appropriate Mongo query, prices each candidate via the existing pricers,
// drops over-budget / unpriceable results, and returns the top 10. No LLM
// involvement here — every number is computed from the operator's own data,
// so results are reproducible and auditable.

import mongoose from 'mongoose';
import Hotel from '../models/Hotel.js';
import Activity from '../models/Activity.js';
import Transport from '../models/Transport.js';
import Package from '../models/Package.js';
import Destination from '../models/Destination.js';
import { priceStay, summarizeCheapestRate } from './rateResolver.js';
import { priceActivity } from './activityPricer.js';
import { priceTransport } from './transportPricer.js';
import { pricePackage } from './packagePricer.js';
import { embedText } from './embeddings.js';

const HOTEL_VECTOR_INDEX = 'hotel_embeddings_v1';

const RESULT_CAP = 10;
const DEFAULT_NIGHTS_WHEN_ONLY_FROM = 3;
const DEFAULT_CHILD_AGE = 8;
const DEFAULT_ADULTS_WHEN_PRICING = 2;

// ─── helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "tented camp" → /tented[ _-]+camp/i so it matches "tented_camp" / "tented-camp"
function flexibleTermRegex(term) {
  const escaped = escapeRegex(term).replace(/\\ /g, ' ');
  const flexible = escaped.replace(/\s+/g, '[ _-]+');
  return new RegExp(flexible, 'i');
}

// AND across terms, OR across the listed candidate fields per term.
function buildMustHaveFilter(terms, fields) {
  if (!terms?.length) return null;
  const ands = terms.map(t => {
    const re = flexibleTermRegex(t);
    return { $or: fields.map(f => ({ [f]: re })) };
  });
  return ands.length === 1 ? ands[0] : { $and: ands };
}

function pickHeroImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const hero = images.find(i => i?.isHero) || images[0];
  return hero?.url || null;
}

function isoToDate(s) { return s ? new Date(s) : null; }

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Resolve a free-text destination name to a canonical name (and Destination
// doc, if present). Falls back to the raw input — partner records can have a
// destination string that the org never created a Destination doc for.
async function resolveDestination(name, organizationId) {
  if (!name) return { canonical: null, destDoc: null };
  const re = new RegExp(`^${escapeRegex(name)}`, 'i');
  const destDoc = await Destination.findOne({ organization: organizationId, name: re, isActive: true }).lean();
  return { canonical: destDoc?.name || name, destDoc };
}

// Total pax — counts children with valid ages AND children with null age (we
// know there's a child even if we don't know how old).
function totalPax(parsed) {
  const adults = parsed.adults ?? DEFAULT_ADULTS_WHEN_PRICING;
  return adults + (parsed.children?.length || 0);
}

// Walk priceStay's child breakdown to detect whether any child bracket fired.
function detectChildRateApplied(priced) {
  if (!priced?.nightly?.length) return false;
  for (const n of priced.nightly) {
    for (const b of (n.breakdown || [])) {
      if (b.children > 0 && Array.isArray(b.childCharges) && b.childCharges.length) return true;
    }
  }
  return false;
}

// ─── HOTELS ───────────────────────────────────────────────────────────────────

// Vector-search path for vibe queries. Returns null on any failure — caller
// falls back to the regex path so an outage in Voyage / a missing Atlas index
// degrades gracefully rather than breaking search outright.
async function fetchHotelsByVector({ organizationId, query, canonical, mustHave }) {
  // The full original query carries the most semantic signal; appending the
  // parser's mustHave terms hardens against the parser dropping qualifiers
  // (e.g. "luxury" buried in a longer prompt).
  const embedInput = [query, ...(mustHave || [])].filter(Boolean).join(' ').trim();
  if (!embedInput) return null;

  let vector;
  try {
    const r = await embedText(embedInput, { inputType: 'query' });
    vector = r.vector;
  } catch (err) {
    console.warn('[search] Voyage embedding failed, falling back to regex:', err.message);
    return null;
  }
  if (!vector) return null;

  const orgObjectId = new mongoose.Types.ObjectId(String(organizationId));
  const pipeline = [
    {
      $vectorSearch: {
        index: HOTEL_VECTOR_INDEX,
        path: 'embeddingV1',
        queryVector: vector,
        numCandidates: 200,
        limit: 100,
        filter: { organization: orgObjectId, isActive: true },
      },
    },
    // Strip the 512-element vector — we don't need it downstream and it
    // bloats the result by orders of magnitude.
    { $project: { embeddingV1: 0 } },
  ];
  if (canonical) {
    const re = flexibleTermRegex(canonical);
    pipeline.push({ $match: { $or: [{ destination: re }, { location: re }] } });
  }
  pipeline.push({ $limit: 50 });

  try {
    return await Hotel.aggregate(pipeline);
  } catch (err) {
    console.warn('[search] $vectorSearch failed, falling back to regex:', err.message);
    return null;
  }
}

async function searchHotels({ parsed, organizationId, canonical, quoteCurrency, query, warnings }) {
  // Vibe path: when the operator gave qualitative cues ("luxury", "tented",
  // "kid-friendly"), use Voyage embeddings + Atlas $vectorSearch. Pure
  // structural queries ("hotel in Mara") skip this — destination regex is
  // already precise and vector adds no signal.
  let hotels = null;
  if (parsed.mustHave?.length && query) {
    hotels = await fetchHotelsByVector({
      organizationId, query, canonical, mustHave: parsed.mustHave,
    });
  }

  if (!hotels || hotels.length === 0) {
    // Regex fallback. Also runs when the org hasn't been backfilled with
    // embeddings yet, or when Voyage / Atlas returned nothing usable.
    const filter = { organization: organizationId, isActive: true };
    if (canonical) {
      const re = flexibleTermRegex(canonical);
      filter.$or = [{ destination: re }, { location: re }];
    }
    // mustHave terms — match against multiple text-bearing fields including type
    // (so "tented camp" hits hotel.type='tented_camp') and amenities array.
    const mustHaveFilter = buildMustHaveFilter(parsed.mustHave, [
      'name', 'description', 'tags', 'type', 'amenities', 'location',
    ]);
    if (mustHaveFilter) Object.assign(filter, mustHaveFilter);
    hotels = await Hotel.find(filter).limit(50).lean();
  }
  if (!hotels.length) return [];

  const checkIn = isoToDate(parsed.dateRange?.from);
  const checkOutRaw = isoToDate(parsed.dateRange?.to);
  const checkOut = checkIn ? (checkOutRaw || addDays(checkIn, DEFAULT_NIGHTS_WHEN_ONLY_FROM)) : null;
  const haveDates = !!(checkIn && checkOut && checkOut > checkIn);

  // Pricing pax — fill assumed defaults but flag them so the UI shows a chip.
  const adults = parsed.adults ?? DEFAULT_ADULTS_WHEN_PRICING;
  const paxAssumed = parsed.adults == null;
  const childAges = (parsed.children || []).map(c => c?.age ?? DEFAULT_CHILD_AGE);
  const childAgesAssumed = (parsed.children || []).some(c => c?.age == null);

  // clientType / nationality come from the parser when the operator wrote them
  // ("contract rate", "for non-resident travelers"). Fall back to the safe
  // defaults so a query with neither still prices.
  const clientType = parsed.clientType || 'retail';
  const nationality = parsed.nationality || 'nonResident';

  const results = [];

  for (const hotel of hotels) {
    if (haveDates) {
      const priced = priceStay({
        hotel,
        checkIn,
        checkOut,
        pax: { adults, childAges },
        clientType,
        nationality,
        preferredMealPlan: parsed.boardBasis || undefined,
        quoteCurrency,
        orgFxOverrides: {},
      });

      if (!priced.ok) continue; // hotel has no rate list / no coverage / zero nights

      const ptMandatoryTotal = (priced.passThroughFees || [])
        .filter(f => f.mandatory !== false)
        .reduce((s, f) => s + (f.amountInQuoteCurrency || 0), 0);

      const total = (priced.subtotalInQuoteCurrency || 0) + ptMandatoryTotal;
      if (parsed.budgetMax && total > parsed.budgetMax) continue;

      const blockingCondition = (priced.conditions || []).some(c => c.severity === 'blocking');

      results.push({
        type: 'hotel',
        id: hotel._id,
        name: hotel.name,
        destination: hotel.destination,
        location: hotel.location || '',
        stars: hotel.stars || null,
        hotelType: hotel.type || 'hotel',
        image: pickHeroImage(hotel.images),
        imagesCount: hotel.images?.length || 0,
        rateListName: priced.rateList?.name || '',
        mealPlan: priced.rateList?.mealPlan || '',
        roomType: priced.roomType || '',
        inclusions: priced.inclusions || [],
        exclusions: priced.exclusions || [],
        computedPrice: {
          pricingMode: 'total',
          total,
          currency: quoteCurrency,
          perNight: priced.nights ? total / priced.nights : null,
          nights: priced.nights,
          sourceCurrency: priced.sourceCurrency,
          fxRate: priced.fxRate,
          breakdown: {
            subtotal: priced.subtotalInQuoteCurrency || 0,
            mandatoryFeesTotal: ptMandatoryTotal,
            mandatoryAddOnsPerNightTotal: priced.mandatoryAddOnsPerNightTotal || 0,
            mandatoryAddOnsPerNight: priced.mandatoryAddOnsPerNight || [],
            optionalAddOns: (priced.addOns || []).filter(a => a.optional),
            passThroughFees: priced.passThroughFees || [],
          },
        },
        flags: {
          noDatesGiven: false,
          paxAssumed,
          childAgeAssumed: childAgesAssumed && childAges.length > 0,
          childRateApplied: detectChildRateApplied(priced),
          blockingCondition,
          imagesMissing: !hotel.images?.length,
          extractionConfidence: priced.extractionConfidence || '',
        },
        warnings: priced.warnings || [],
      });
    } else {
      // No dates — use summarizeCheapestRate for a "from $X per person" signal.
      const summary = summarizeCheapestRate(hotel, { clientType, quoteCurrency, orgFxOverrides: {} });
      if (!summary) continue;

      const perPerson = summary.perPersonSharingInQuoteCurrency || 0;
      // Apply budget filter generously when we don't have a real total.
      // Operators often state per-trip budget; per-person is much lower, so
      // include if perPerson <= budgetMax (a conservative pass-through).
      if (parsed.budgetMax && perPerson > parsed.budgetMax) continue;

      results.push({
        type: 'hotel',
        id: hotel._id,
        name: hotel.name,
        destination: hotel.destination,
        location: hotel.location || '',
        stars: hotel.stars || null,
        hotelType: hotel.type || 'hotel',
        image: pickHeroImage(hotel.images),
        imagesCount: hotel.images?.length || 0,
        rateListName: summary.rateListName,
        mealPlan: summary.mealPlan,
        roomType: summary.roomType,
        inclusions: [],
        exclusions: [],
        computedPrice: {
          pricingMode: 'perPersonEstimate',
          perPerson,
          currency: quoteCurrency,
          sourceCurrency: summary.sourceCurrency,
          label: summary.label,
        },
        flags: {
          noDatesGiven: true,
          paxAssumed: false,
          childAgeAssumed: false,
          childRateApplied: false,
          blockingCondition: false,
          imagesMissing: !hotel.images?.length,
          extractionConfidence: '',
        },
        warnings: [],
      });
    }
  }

  // Rank: cheapest first when we have totals; alphabetical when we have estimates.
  results.sort((a, b) => {
    const av = a.computedPrice.total ?? a.computedPrice.perPerson ?? Infinity;
    const bv = b.computedPrice.total ?? b.computedPrice.perPerson ?? Infinity;
    return av - bv;
  });

  return results.slice(0, RESULT_CAP);
}

// ─── ACTIVITIES ───────────────────────────────────────────────────────────────

async function searchActivities({ parsed, organizationId, canonical, quoteCurrency }) {
  const filter = { organization: organizationId, isActive: true };
  if (canonical) filter.destination = flexibleTermRegex(canonical);

  const mustHaveFilter = buildMustHaveFilter(parsed.mustHave, [
    'name', 'description', 'tags',
  ]);
  if (mustHaveFilter) Object.assign(filter, mustHaveFilter);

  const activities = await Activity.find(filter).limit(50).lean();
  if (!activities.length) return [];

  const adults = parsed.adults ?? 0;
  const children = parsed.children?.length || 0;
  const childAges = (parsed.children || []).map(c => c?.age ?? DEFAULT_CHILD_AGE);
  const noPaxGiven = parsed.adults == null && children === 0;

  const results = [];
  for (const a of activities) {
    const priced = priceActivity(a, {
      adults: adults || 1,
      children,
      childAges,
      quoteCurrency,
      orgFxOverrides: {},
    });

    if (parsed.budgetMax && priced.totalCostInQuoteCurrency > parsed.budgetMax) continue;

    results.push({
      type: 'activity',
      id: a._id,
      name: a.name,
      destination: a.destination,
      duration: a.duration || 0,
      season: a.season || 'all',
      image: pickHeroImage(a.images),
      imagesCount: a.images?.length || 0,
      computedPrice: {
        pricingMode: priced.pricingModel,
        total: priced.totalCostInQuoteCurrency,
        currency: quoteCurrency,
        sourceCurrency: priced.sourceCurrency,
        fxRate: priced.fxRate,
      },
      flags: {
        noPaxGiven,
        minAgeViolation: priced.warnings.some(w => /minimum age/i.test(w)),
        groupSizeExceeded: priced.warnings.some(w => /max group size/i.test(w)),
        imagesMissing: !a.images?.length,
      },
      warnings: priced.warnings || [],
    });
  }

  results.sort((a, b) => (a.computedPrice.total ?? Infinity) - (b.computedPrice.total ?? Infinity));
  return results.slice(0, RESULT_CAP);
}

// ─── TRANSPORT ────────────────────────────────────────────────────────────────

async function searchTransport({ parsed, organizationId, canonical, quoteCurrency }) {
  const filter = { organization: organizationId, isActive: true };
  if (canonical) {
    const re = flexibleTermRegex(canonical);
    filter.$or = [{ destinations: re }, { routeOrZone: re }];
  }

  const mustHaveFilter = buildMustHaveFilter(parsed.mustHave, [
    'name', 'notes', 'type', 'routeOrZone',
  ]);
  if (mustHaveFilter) Object.assign(filter, mustHaveFilter);

  const transports = await Transport.find(filter).limit(50).lean();
  if (!transports.length) return [];

  const adults = parsed.adults ?? 0;
  const children = parsed.children?.length || 0;

  // Days inferred from dateRange when present; otherwise 1 with a flag.
  const checkIn = isoToDate(parsed.dateRange?.from);
  const checkOut = isoToDate(parsed.dateRange?.to);
  let days = 1;
  let noDaysGiven = true;
  if (checkIn && checkOut && checkOut > checkIn) {
    days = Math.max(1, Math.round((checkOut - checkIn) / 86400000));
    noDaysGiven = false;
  }

  const results = [];
  for (const t of transports) {
    const priced = priceTransport(t, {
      adults: adults || 1,
      children,
      days,
      distanceKm: 0,
      quoteCurrency,
      orgFxOverrides: {},
    });

    if (parsed.budgetMax && priced.totalCostInQuoteCurrency > parsed.budgetMax) continue;

    results.push({
      type: 'transport',
      id: t._id,
      name: t.name,
      transportType: t.type,
      capacity: t.capacity || 0,
      routeOrZone: t.routeOrZone || '',
      image: pickHeroImage(t.images),
      imagesCount: t.images?.length || 0,
      computedPrice: {
        pricingMode: priced.pricingModel,
        total: priced.totalCostInQuoteCurrency,
        currency: quoteCurrency,
        sourceCurrency: priced.sourceCurrency,
        fxRate: priced.fxRate,
        days: priced.days,
      },
      flags: {
        noDaysGiven,
        capacityExceeded: priced.warnings.some(w => /capacity/i.test(w)),
        imagesMissing: !t.images?.length,
      },
      warnings: priced.warnings || [],
    });
  }

  results.sort((a, b) => (a.computedPrice.total ?? Infinity) - (b.computedPrice.total ?? Infinity));
  return results.slice(0, RESULT_CAP);
}

// ─── PACKAGES ─────────────────────────────────────────────────────────────────
// Delegates to packagePricer.js which mirrors rateResolver's shape: handles
// audience/validity/season filtering, pax tiers (with cheapest-tier fallback),
// child rebates by age bracket, and single-traveler supplement.

async function searchPackages({ parsed, organizationId, canonical, quoteCurrency }) {
  const filter = { organization: organizationId, isActive: true };
  if (canonical) filter.destination = flexibleTermRegex(canonical);

  const mustHaveFilter = buildMustHaveFilter(parsed.mustHave, [
    'name', 'description', 'tags', 'destination',
  ]);
  if (mustHaveFilter) Object.assign(filter, mustHaveFilter);

  const packages = await Package.find(filter).limit(50).lean();
  if (!packages.length) return [];

  const adults = parsed.adults ?? DEFAULT_ADULTS_WHEN_PRICING;
  const paxAssumed = parsed.adults == null;
  const childAges = (parsed.children || []).map(c => c?.age ?? DEFAULT_CHILD_AGE);
  const childAgesAssumed = (parsed.children || []).some(c => c?.age == null);
  const refDate = isoToDate(parsed.dateRange?.from) || new Date();

  // Packages have audience-tagged pricing lists (retail / contract / resident);
  // nationality is not in the package data model so it isn't plumbed here.
  const clientType = parsed.clientType || 'retail';

  const results = [];
  for (const pkg of packages) {
    const priced = pricePackage({
      pkg,
      date: refDate,
      pax: { adults, childAges },
      clientType,
      preferredMealPlan: parsed.boardBasis || undefined,
      quoteCurrency,
      orgFxOverrides: {},
    });
    if (!priced.ok) continue;
    if (parsed.budgetMax && priced.subtotalInQuoteCurrency > parsed.budgetMax) continue;

    const childRebateApplied = priced.perChildBreakdown.length > 0
      && priced.perChildBreakdown.some(c => c.mode !== 'full');

    results.push({
      type: 'package',
      id: pkg._id,
      name: pkg.name,
      destination: pkg.destination,
      durationNights: pkg.durationNights || 0,
      durationDays: pkg.durationDays || 0,
      image: pickHeroImage(pkg.images),
      imagesCount: pkg.images?.length || 0,
      pricingListName: priced.pricingList.name,
      mealPlan: priced.pricingList.mealPlan || '',
      inclusions: priced.inclusions,
      exclusions: priced.exclusions,
      computedPrice: {
        pricingMode: 'perPerson',
        perPerson: priced.perPersonAdult * priced.fxRate,
        total: priced.subtotalInQuoteCurrency,
        currency: quoteCurrency,
        sourceCurrency: priced.sourceCurrency,
        fxRate: priced.fxRate,
        paxTier: priced.paxTier,
        breakdown: {
          adults: priced.adultsTotal * priced.fxRate,
          children: priced.childrenTotal * priced.fxRate,
          singleSupplement: priced.singleSupplement * priced.fxRate,
          perChild: priced.perChildBreakdown.map(c => ({
            age: c.age,
            amount: (c.amount || 0) * priced.fxRate,
            mode: c.mode,
            label: c.label,
          })),
        },
      },
      flags: {
        paxAssumed,
        childAgeAssumed: childAgesAssumed && childAges.length > 0,
        paxTierFallback: priced.paxTierFallback,
        childRateApplied: childRebateApplied,
        imagesMissing: !pkg.images?.length,
      },
      warnings: priced.warnings || [],
    });
  }

  results.sort((a, b) => (a.computedPrice.total ?? Infinity) - (b.computedPrice.total ?? Infinity));
  return results.slice(0, RESULT_CAP);
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

/**
 * Run the structured search against the org's inventory.
 * Returns { results, destination, warnings }.
 *
 * `parsed` shape comes from searchParser.parseQuery.
 * `query` is the operator's raw text — used for vector-search embedding on hotels.
 */
export async function executeSearch({ parsed, organizationId, query }) {
  const warnings = [];
  const quoteCurrency = parsed.currency || 'USD';

  const { canonical, destDoc } = await resolveDestination(parsed.destinationName, organizationId);
  if (parsed.destinationName && !destDoc) {
    warnings.push(`No destination matched "${parsed.destinationName}" exactly — searching by name match.`);
  }

  const type = parsed.type || 'hotel'; // default to hotel when type unspecified
  const args = { parsed, organizationId, canonical, quoteCurrency, warnings, query };

  let results = [];
  if (type === 'hotel') results = await searchHotels(args);
  else if (type === 'activity') results = await searchActivities(args);
  else if (type === 'transport') results = await searchTransport(args);
  else if (type === 'package') results = await searchPackages(args);

  return {
    results,
    destination: destDoc ? {
      id: destDoc._id, name: destDoc.name, region: destDoc.region, country: destDoc.country,
    } : null,
    canonical,
    quoteCurrency,
    warnings,
  };
}
