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
// Wider than this we treat the dateRange as a search window ("in July") rather
// than a real stay. The pricer gets a 3-night sample inside the window and the
// operator sees per-night pricing instead of a multi-week trip total they
// didn't ask for. Budget filters then compare against per-night, not total.
const MAX_STAY_SPAN_DAYS = 10;

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
// Build the propertyType $or clause: type ∈ <list> OR name regex matching the
// human-readable variant. The name match is forgiving for records that are
// type-mislabeled — e.g. "AA Lodge Maasai Mara" tagged as `tented_camp` still
// surfaces for a "lodge" query.
function buildPropertyTypeClause(propertyType) {
  if (!propertyType?.length) return null;
  const clauses = [{ type: { $in: propertyType } }];
  for (const t of propertyType) {
    clauses.push({ name: flexibleTermRegex(t.replace(/_/g, ' ')) });
  }
  return { $or: clauses };
}

async function fetchHotelsByVector({ organizationId, query, canonical, mustHave, propertyType }) {
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
  // Atlas index doesn't carry `type` as a filter field, so apply property-type
  // narrowing as a post-vectorSearch $match. Forgiving: type ∈ list OR name match.
  const ptClause = buildPropertyTypeClause(propertyType);
  if (ptClause) pipeline.push({ $match: ptClause });
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
      organizationId, query, canonical,
      mustHave: parsed.mustHave,
      propertyType: parsed.propertyType,
    });
  }

  if (!hotels || hotels.length === 0) {
    // Regex fallback. Also runs when the org hasn't been backfilled with
    // embeddings yet, or when Voyage / Atlas returned nothing usable.
    //
    // Multiple clauses (destination, propertyType, mustHave) are AND'd together
    // via $and so independent $or conditions don't clobber each other.
    const filter = { organization: organizationId, isActive: true };
    const conjuncts = [];

    if (canonical) {
      const re = flexibleTermRegex(canonical);
      conjuncts.push({ $or: [{ destination: re }, { location: re }] });
    }

    const ptClause = buildPropertyTypeClause(parsed.propertyType);
    if (ptClause) conjuncts.push(ptClause);

    // mustHave terms — match against multiple text-bearing fields. Property-type
    // words have already been promoted to parsed.propertyType by the parser so
    // they don't double-filter here.
    const mustHaveFilter = buildMustHaveFilter(parsed.mustHave, [
      'name', 'description', 'tags', 'amenities', 'location',
    ]);
    if (mustHaveFilter) conjuncts.push(mustHaveFilter);

    if (conjuncts.length) filter.$and = conjuncts;
    hotels = await Hotel.find(filter).limit(50).lean();
  }
  if (!hotels.length) return [];

  const checkIn = isoToDate(parsed.dateRange?.from);
  const checkOutRaw = isoToDate(parsed.dateRange?.to);

  // Stay window vs search window:
  //   "Jul 3 – Jul 7" (4 days)  → stay window: real check-in/out, total trip cost
  //   "in July" (Jul 1 – Jul 31) → search window: price a 3-night sample, show per-night
  //   "from Jul 3" (no `to`)    → stay window with default 3-night assumption
  // The heuristic is purely span-based — no parser change needed.
  let checkOut = null;
  let isSearchWindow = false;
  if (checkIn && checkOutRaw) {
    const spanDays = Math.round((checkOutRaw - checkIn) / 86400000);
    if (spanDays > MAX_STAY_SPAN_DAYS) {
      checkOut = addDays(checkIn, DEFAULT_NIGHTS_WHEN_ONLY_FROM);
      isSearchWindow = true;
    } else {
      checkOut = checkOutRaw;
    }
  } else if (checkIn) {
    checkOut = addDays(checkIn, DEFAULT_NIGHTS_WHEN_ONLY_FROM);
  }
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
      const perNight = priced.nights ? total / priced.nights : null;

      // Budget comparison target depends on mode: per-night in a search window
      // ("in July under $200" → operator means $200/night), trip total in a
      // proper stay window ("Jul 3-7 under $1000" → operator means $1000 total).
      if (parsed.budgetMax) {
        const target = isSearchWindow ? perNight : total;
        if (target != null && target > parsed.budgetMax) continue;
      }

      const blockingCondition = (priced.conditions || []).some(c => c.severity === 'blocking');

      const sharedShape = {
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
        warnings: priced.warnings || [],
      };
      const sharedFlags = {
        noDatesGiven: false,
        paxAssumed,
        childAgeAssumed: childAgesAssumed && childAges.length > 0,
        childRateApplied: detectChildRateApplied(priced),
        blockingCondition,
        imagesMissing: !hotel.images?.length,
        extractionConfidence: priced.extractionConfidence || '',
      };

      if (isSearchWindow) {
        results.push({
          ...sharedShape,
          computedPrice: {
            pricingMode: 'perNightInWindow',
            perNight,
            currency: quoteCurrency,
            sourceCurrency: priced.sourceCurrency,
            fxRate: priced.fxRate,
            // Sample window we actually priced (3 nights at the start of the
            // operator's search window) — the UI shows this so the operator
            // knows what produced the per-night number.
            sample: {
              nights: priced.nights,
              checkIn: checkIn.toISOString().slice(0, 10),
              checkOut: checkOut.toISOString().slice(0, 10),
            },
            window: {
              from: parsed.dateRange?.from || null,
              to: parsed.dateRange?.to || null,
            },
            breakdown: {
              mandatoryFeesTotal: ptMandatoryTotal,
              mandatoryAddOnsPerNightTotal: priced.mandatoryAddOnsPerNightTotal || 0,
              mandatoryAddOnsPerNight: priced.mandatoryAddOnsPerNight || [],
              passThroughFees: priced.passThroughFees || [],
            },
          },
          flags: { ...sharedFlags, searchWindowMode: true },
        });
      } else {
        results.push({
          ...sharedShape,
          computedPrice: {
            pricingMode: 'total',
            total,
            currency: quoteCurrency,
            perNight,
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
          flags: { ...sharedFlags, searchWindowMode: false },
        });
      }
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

  // Rank: cheapest first across whichever number we have for each result —
  // total (stay window), perNight (search window), perPerson (no dates).
  results.sort((a, b) => {
    const av = a.computedPrice.total ?? a.computedPrice.perNight ?? a.computedPrice.perPerson ?? Infinity;
    const bv = b.computedPrice.total ?? b.computedPrice.perNight ?? b.computedPrice.perPerson ?? Infinity;
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

// ─── LOOKUP (Q&A intent) ──────────────────────────────────────────────────────
// Pulls the named partner + the topic-specific fields the rationale step needs
// to answer "what's the cancellation policy for Serena?", "does X include park
// fees?", etc. No pricing involved — we're asking ABOUT a partner, not pricing
// them.

async function findLookupCandidates({ subjectName, organizationId, type }) {
  if (!subjectName) return [];

  const re = flexibleTermRegex(subjectName);
  const filter = { organization: organizationId, isActive: true, name: re };

  if (type === 'hotel') {
    return (await Hotel.find(filter).limit(5).lean()).map(h => ({ ...h, _kind: 'hotel' }));
  }
  if (type === 'activity') {
    return (await Activity.find(filter).limit(5).lean()).map(a => ({ ...a, _kind: 'activity' }));
  }
  if (type === 'transport') {
    return (await Transport.find(filter).limit(5).lean()).map(t => ({ ...t, _kind: 'transport' }));
  }
  if (type === 'package') {
    return (await Package.find(filter).limit(5).lean()).map(p => ({ ...p, _kind: 'package' }));
  }

  // No type specified — fan out across all four. Hotels get priority since
  // most "tell me about X" queries are hotel-focused.
  const [hotels, packages, activities, transports] = await Promise.all([
    Hotel.find(filter).limit(5).lean(),
    Package.find(filter).limit(3).lean(),
    Activity.find(filter).limit(3).lean(),
    Transport.find(filter).limit(3).lean(),
  ]);
  return [
    ...hotels.map(h => ({ ...h, _kind: 'hotel' })),
    ...packages.map(p => ({ ...p, _kind: 'package' })),
    ...activities.map(a => ({ ...a, _kind: 'activity' })),
    ...transports.map(t => ({ ...t, _kind: 'transport' })),
  ].slice(0, 5);
}

// Pick the most authoritative current rate list for topic extraction —
// active, in-validity (preferred), highest priority. Falls back to any active
// list if none are currently in window.
function pickActiveRateList(hotel) {
  const lists = (hotel.rateLists || []).filter(l => l.isActive !== false);
  if (!lists.length) return null;
  const now = Date.now();
  const current = lists.filter(l => {
    if (!l.validFrom && !l.validTo) return true;
    if (l.validFrom && now < new Date(l.validFrom).getTime()) return false;
    if (l.validTo && now > new Date(l.validTo).getTime()) return false;
    return true;
  });
  return (current.length ? current : lists)
    .slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
}

// Strip the partner doc down to the fields relevant to the topic. Keeps the
// LLM input small and prevents unrelated data (like full image URLs) from
// inflating tokens or appearing in the answer.
function buildLookupPayload(partner, topic) {
  const base = {
    kind: partner._kind,
    id: partner._id,
    name: partner.name,
    destination: partner.destination || null,
    location: partner.location || null,
    image: pickHeroImage(partner.images),
  };

  if (partner._kind !== 'hotel') {
    // Topic-specific extraction is hotel-focused for now. For non-hotels,
    // return general info — the rationale layer can answer generally.
    return {
      ...base,
      topic: 'general',
      generalInfo: {
        type: partner._kind,
        description: partner.description || '',
        amenities: partner.amenities || [],
        meta: partner._kind === 'package'
            ? { durationNights: partner.durationNights, durationDays: partner.durationDays, segments: partner.segments?.length || 0 }
          : partner._kind === 'activity'
            ? { duration: partner.duration, season: partner.season, pricingModel: partner.pricingModel }
          : partner._kind === 'transport'
            ? { type: partner.type, capacity: partner.capacity, pricingModel: partner.pricingModel }
          : {},
      },
    };
  }

  const rateList = pickActiveRateList(partner);

  if (topic === 'cancellation_policy') {
    return {
      ...base,
      topic,
      cancellation: rateList ? {
        rateListName: rateList.name,
        currency: rateList.currency,
        depositPct: rateList.depositPct || 0,
        tiers: rateList.cancellationTiers || [],
        bookingTerms: rateList.bookingTerms || '',
      } : null,
    };
  }
  if (topic === 'inclusions') {
    return {
      ...base,
      topic,
      inclusions: rateList ? {
        rateListName: rateList.name,
        mealPlan: rateList.mealPlan,
        mealPlanLabel: rateList.mealPlanLabel,
        items: rateList.inclusions || [],
      } : null,
    };
  }
  if (topic === 'exclusions') {
    return {
      ...base,
      topic,
      exclusions: rateList ? {
        rateListName: rateList.name,
        items: rateList.exclusions || [],
        mandatoryFees: (rateList.passThroughFees || []).filter(f => f.mandatory !== false).map(f => ({
          name: f.name, unit: f.unit, currency: f.currency,
        })),
      } : null,
    };
  }
  if (topic === 'fees') {
    return {
      ...base,
      topic,
      fees: rateList ? {
        rateListName: rateList.name,
        passThroughFees: rateList.passThroughFees || [],
      } : null,
    };
  }
  if (topic === 'rates') {
    return {
      ...base,
      topic,
      rates: {
        currency: partner.currency,
        rateListCount: (partner.rateLists || []).filter(l => l.isActive !== false).length,
        cheapest: summarizeCheapestRate(partner, { quoteCurrency: partner.currency || 'USD', orgFxOverrides: {} }),
        rateLists: (partner.rateLists || []).filter(l => l.isActive !== false).map(l => ({
          name: l.name,
          audience: l.audience,
          currency: l.currency,
          mealPlan: l.mealPlan,
          validFrom: l.validFrom,
          validTo: l.validTo,
          priority: l.priority,
        })),
      },
    };
  }
  if (topic === 'rooms') {
    const roomTypes = new Set();
    for (const list of (partner.rateLists || [])) {
      if (list.isActive === false) continue;
      for (const season of (list.seasons || [])) {
        for (const r of (season.rooms || [])) {
          if (r.roomType) roomTypes.add(r.roomType);
        }
      }
    }
    return { ...base, topic, rooms: [...roomTypes] };
  }
  if (topic === 'child_policy') {
    // Aggregate child brackets across the active rate list. Operators usually
    // mean "what's the rule" not "show me every season's variant" — but we
    // pass them all and let the LLM summarize.
    const brackets = [];
    if (rateList) {
      for (const season of (rateList.seasons || [])) {
        for (const r of (season.rooms || [])) {
          for (const b of (r.childBrackets || [])) {
            brackets.push({ season: season.label, roomType: r.roomType, ...b });
          }
        }
      }
    }
    return { ...base, topic, childPolicy: { rateListName: rateList?.name, brackets } };
  }
  if (topic === 'amenities') {
    return { ...base, topic, amenities: partner.amenities || [] };
  }
  // 'general' or unrecognized topic
  return {
    ...base,
    topic: 'general',
    generalInfo: {
      type: partner.type,
      stars: partner.stars,
      description: partner.description || '',
      amenities: partner.amenities || [],
      contactEmail: partner.contactEmail || null,
      contactPhone: partner.contactPhone || null,
      currency: partner.currency,
      rateListCount: (partner.rateLists || []).filter(l => l.isActive !== false).length,
    },
  };
}

/**
 * Resolve a Q&A query to a single partner + topic-specific data.
 * Returns one of:
 *   { lookup: <payload>, candidates: [] }            — exact match found
 *   { lookup: null, candidates: [<slim>...] }        — multiple matches; ask operator to pick
 *   { lookup: null, candidates: [], message: '...' } — no matches
 */
export async function executeLookup({ parsed, organizationId }) {
  const candidates = await findLookupCandidates({
    subjectName: parsed.subjectName,
    organizationId,
    type: parsed.type,
  });

  if (!candidates.length) {
    return {
      lookup: null,
      candidates: [],
      message: `No partner matched "${parsed.subjectName}".`,
    };
  }

  if (candidates.length === 1) {
    const topic = parsed.lookupTopic || 'general';
    return { lookup: buildLookupPayload(candidates[0], topic), candidates: [] };
  }

  // Multiple — return slim candidate cards so the operator picks.
  return {
    lookup: null,
    candidates: candidates.map(c => ({
      kind: c._kind,
      id: c._id,
      name: c.name,
      destination: c.destination || null,
      location: c.location || null,
      image: pickHeroImage(c.images),
    })),
  };
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
