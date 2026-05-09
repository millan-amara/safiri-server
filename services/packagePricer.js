// Package pricing.
//
// Mirrors the shape of rateResolver.priceStay but tuned to the simpler
// pricing model packages use: pax-tiered per-person rates, optional single
// supplement for solo travelers, and child rebates by age bracket. Multi-day
// packages are priced as a single bundle (the duration is intrinsic to the
// package), so we don't iterate per-night the way hotels do.
//
// Two entry points: pickPricingList for "which sheet applies?" and
// pricePackage for the full priced quote.

import { getFxRate } from '../utils/fx.js';

// ─── eligibility helpers ──────────────────────────────────────────────────────

function audienceMatches(audience, clientType) {
  if (!audience?.length) return true;
  const ct = String(clientType || '').toLowerCase();
  return audience.some(a => String(a).toLowerCase() === ct);
}

function validityCovers(list, date) {
  if (!date) return true;
  const t = new Date(date).getTime();
  if (list.validFrom && t < new Date(list.validFrom).getTime()) return false;
  if (list.validTo && t > new Date(list.validTo).getTime()) return false;
  return true;
}

// seasonDateRanges narrow a list to specific date windows inside its validity
// (e.g. an "Easter 2026" list with one or two date stretches). Empty = applies
// across the full validity window.
function seasonCovers(list, date) {
  if (!list.seasonDateRanges?.length) return true;
  const t = new Date(date).getTime();
  return list.seasonDateRanges.some(r => {
    const from = r.from ? new Date(r.from).getTime() : -Infinity;
    const to = r.to ? new Date(r.to).getTime() : Infinity;
    return t >= from && t <= to;
  });
}

function pickPaxTier(tiers, totalPax) {
  if (!tiers?.length) return null;
  return tiers.find(t => totalPax >= (t.minPax || 1) && totalPax <= (t.maxPax || 99)) || null;
}

// Resolve one child's charge against the bracket list. Returns the source-
// currency amount plus a label so the renderer can show how it was derived.
//
// Modes (matching the package childBracketSchema):
//   'free' — child stays free
//   'flat' — fixed amount per child in the list's currency
//   'pct'  — % of the adult per-person tier price
//
// If no bracket matches the child's age, they pay the full adult rate (the
// safe default — the operator should add a bracket if they intend a discount).
function chargeForChild(brackets, age, perPersonAdult, currency) {
  if (age == null || !brackets?.length) {
    return { amount: perPersonAdult, mode: 'full', label: 'No child bracket — pays full adult rate', currency };
  }
  const matching = brackets.find(b => age >= (b.minAge || 0) && age <= (b.maxAge || 17));
  if (!matching) {
    return { amount: perPersonAdult, mode: 'full', label: 'No matching bracket — pays full adult rate', currency };
  }
  let amount = 0;
  switch (matching.mode) {
    case 'free':
      amount = 0;
      break;
    case 'flat':
      amount = Number(matching.value) || 0;
      break;
    case 'pct':
    default:
      amount = perPersonAdult * ((Number(matching.value) || 0) / 100);
      break;
  }
  return {
    amount,
    mode: matching.mode || 'pct',
    label: matching.label || `${matching.mode || 'pct'}:${matching.value}`,
    currency,
  };
}

// ─── entry points ─────────────────────────────────────────────────────────────

/**
 * Pick the highest-priority pricing list whose audience, validity, and season
 * window match. Returns { pricingList, warnings, reason }.
 */
export function pickPricingList(pkg, { date = new Date(), clientType = 'retail', preferredMealPlan } = {}) {
  const warnings = [];
  const lists = (pkg.pricingLists || []).filter(l => l.isActive !== false);

  if (!lists.length) {
    warnings.push('Package has no active pricing lists.');
    return { pricingList: null, warnings, reason: 'no_active_pricing_lists' };
  }

  let eligible = lists.filter(l => audienceMatches(l.audience, clientType));
  if (!eligible.length) {
    warnings.push(`No pricing lists match clientType=${clientType}. Falling back to any active list.`);
    eligible = lists;
  }

  const inWindow = eligible.filter(l => validityCovers(l, date) && seasonCovers(l, date));
  if (!inWindow.length) {
    const windows = lists
      .map(l => `${l.name}: ${l.validFrom ? new Date(l.validFrom).toISOString().slice(0, 10) : '∞'} → ${l.validTo ? new Date(l.validTo).toISOString().slice(0, 10) : '∞'}`)
      .join('; ');
    warnings.push(`No pricing list covers ${new Date(date).toISOString().slice(0, 10)}. Configured windows — ${windows}.`);
    return { pricingList: null, warnings, reason: 'date_not_covered' };
  }

  let byMeal = inWindow;
  if (preferredMealPlan) {
    const matched = inWindow.filter(l => String(l.mealPlan).toUpperCase() === String(preferredMealPlan).toUpperCase());
    if (matched.length) byMeal = matched;
    else warnings.push(`No list with mealPlan=${preferredMealPlan}; using available plan instead.`);
  }

  const sorted = byMeal.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return { pricingList: sorted[0], warnings };
}

/**
 * Price a package booking. Returns { ok, ...full priced result } on success
 * or { ok: false, warnings, reason } when no pricing list applies.
 */
export function pricePackage({
  pkg,
  date = new Date(),
  pax = { adults: 2, childAges: [] },
  clientType = 'retail',
  preferredMealPlan,
  quoteCurrency = 'USD',
  orgFxOverrides = {},
}) {
  const warnings = [];
  const picked = pickPricingList(pkg, { date, clientType, preferredMealPlan });
  warnings.push(...picked.warnings);
  const list = picked.pricingList;
  if (!list) return { ok: false, warnings, reason: picked.reason || 'no_pricing_list' };

  const adults = Math.max(0, Number(pax.adults) || 0);
  const childAges = Array.isArray(pax.childAges) ? pax.childAges : [];
  const totalPax = adults + childAges.length;

  if (totalPax === 0) {
    return { ok: false, warnings: [...warnings, 'No pax provided.'], reason: 'no_pax' };
  }

  let tier = pickPaxTier(list.paxTiers, totalPax);
  let paxTierFallback = false;
  if (!tier) {
    if (list.paxTiers?.length) {
      // Fall back to cheapest tier rather than dropping the package — operators
      // would rather see a flagged result than no result. The flag tells the
      // UI to render a "tier mismatch" caveat.
      tier = list.paxTiers.slice().sort((a, b) => (a.pricePerPerson || 0) - (b.pricePerPerson || 0))[0];
      paxTierFallback = true;
      warnings.push(`No pax tier matches ${totalPax} pax; using cheapest tier (${tier.minPax}-${tier.maxPax}) as fallback.`);
    } else {
      return { ok: false, warnings: [...warnings, 'Pricing list has no pax tiers.'], reason: 'no_pax_tiers' };
    }
  }

  const perPersonAdult = Number(tier.pricePerPerson) || 0;
  const adultsTotal = perPersonAdult * adults;

  const perChildBreakdown = childAges.map(age => {
    const c = chargeForChild(list.childBrackets, age, perPersonAdult, list.currency);
    return { age, ...c };
  });
  const childrenTotal = perChildBreakdown.reduce((s, x) => s + (x.amount || 0), 0);

  // Single supplement applies to the lone adult traveling without a roomshare.
  // Most package sheets only define this when adults === 1; we follow that
  // convention and don't apply it to multi-adult parties.
  let singleSupp = 0;
  if (adults === 1 && (Number(list.singleSupplement) || 0) > 0) {
    singleSupp = Number(list.singleSupplement);
  }

  const subtotalSource = adultsTotal + childrenTotal + singleSupp;

  const fxRate = getFxRate(list.currency, quoteCurrency, orgFxOverrides) ?? 1;
  if (fxRate === 1 && String(list.currency).toUpperCase() !== String(quoteCurrency).toUpperCase()) {
    warnings.push(`FX rate ${list.currency}→${quoteCurrency} missing; using 1:1. Check org FX settings.`);
  }

  return {
    ok: true,
    pricingList: {
      _id: list._id,
      name: list.name,
      audience: list.audience,
      currency: list.currency,
      mealPlan: list.mealPlan,
      mealPlanLabel: list.mealPlanLabel,
      seasonLabel: list.seasonLabel || '',
      priority: list.priority,
      notes: list.notes || '',
    },
    paxTier: { minPax: tier.minPax, maxPax: tier.maxPax, pricePerPerson: perPersonAdult },
    paxTierFallback,
    pax: { adults, childAges, totalPax },
    perPersonAdult,
    adultsTotal,
    perChildBreakdown,
    childrenTotal,
    singleSupplement: singleSupp,
    subtotalSource,
    subtotalInQuoteCurrency: subtotalSource * fxRate,
    sourceCurrency: list.currency,
    quoteCurrency,
    fxRate,
    inclusions: list.inclusions || [],
    exclusions: list.exclusions || [],
    cancellationTiers: pkg.cancellationTiers || [],
    depositPct: pkg.depositPct || 0,
    bookingTerms: pkg.bookingTerms || '',
    notes: list.notes || '',
    warnings,
  };
}
