// Activity pricing.
//
// Activities live in their own currency (operator's local default, often KES
// for East Africa). When attached to a quote in a different currency we must
// convert at snapshot time using the org's FX overrides — otherwise dayCost
// silently mixes shillings with dollars and the quote total goes wrong.
//
// Shape mirrors what `priceStay` returns for hotels so the client can store
// FX context (sourceCurrency, fxRate) on the day.activities[] snapshot and
// quote totals stay reproducible if FX shifts later.

import { getFxRate } from '../utils/fx.js';

export function priceActivity(activity, { adults = 0, children = 0, childAges = [], quoteCurrency = 'USD', orgFxOverrides = {} } = {}) {
  const sourceCurrency = activity.currency || quoteCurrency;
  const ages = Array.isArray(childAges) ? childAges : [];
  // If childAges is provided, use its length authoritatively; otherwise fall
  // back to the `children` count. Some callers send only one or the other.
  const childCount = ages.length || (Number(children) || 0);
  const totalPax = (Number(adults) || 0) + childCount;

  let totalCost = 0;
  switch (activity.pricingModel) {
    case 'per_group':
      totalCost = Number(activity.groupRate) || 0;
      break;
    case 'flat':
      totalCost = Number(activity.costPerPerson) || Number(activity.groupRate) || 0;
      break;
    case 'per_person':
    default:
      totalCost = (Number(activity.costPerPerson) || 0) * totalPax;
      break;
  }

  const fxRate = getFxRate(sourceCurrency, quoteCurrency, orgFxOverrides) ?? 1;
  const totalCostInQuoteCurrency = totalCost * fxRate;

  // Constraint warnings — surfaced to the operator so they don't silently
  // book an activity the party doesn't qualify for. We don't block the
  // booking; many minAge floors are guidelines that operators waive case by
  // case (e.g. 12+ on safari walks, but private tour with experienced kids).
  const warnings = [];
  const minAge = Number(activity.minimumAge) || 0;
  if (minAge > 0 && ages.length) {
    const tooYoung = ages.filter(a => Number(a) < minAge);
    if (tooYoung.length) {
      warnings.push(
        `${activity.name}: minimum age is ${minAge}, party has ${tooYoung.length} child${tooYoung.length === 1 ? '' : 'ren'} under that (${tooYoung.join(', ')}).`
      );
    }
  }
  const maxGroup = Number(activity.maxGroupSize) || 0;
  if (maxGroup > 0 && totalPax > maxGroup) {
    warnings.push(
      `${activity.name}: max group size is ${maxGroup}, party is ${totalPax}. May need to split into ${Math.ceil(totalPax / maxGroup)} bookings.`
    );
  }

  return {
    sourceCurrency,
    quoteCurrency,
    fxRate,
    totalCost,
    totalCostInQuoteCurrency,
    pricingModel: activity.pricingModel || 'per_person',
    warnings,
  };
}
