// Transport pricing.
//
// Vehicles, flights, transfers — anything in the Transport partner type. Same
// shape as activityPricer/rateResolver: source currency in, quote currency out,
// FX context returned so the snapshot is reproducible after FX shifts.
//
// pricingModel cases:
//   per_day        — rate × days (caller passes `days`, default 1)
//   per_trip       — rate as a one-shot
//   per_person     — rate × totalPax
//   per_km         — rate × distanceKm (caller passes `distanceKm`)

import { getFxRate } from '../utils/fx.js';

export function priceTransport(transport, { adults = 0, children = 0, days = 1, distanceKm = 0, quoteCurrency = 'USD', orgFxOverrides = {} } = {}) {
  const sourceCurrency = transport.currency || quoteCurrency;
  const totalPax = (Number(adults) || 0) + (Number(children) || 0);
  const rate = Number(transport.rate) || 0;

  let totalCost = 0;
  switch (transport.pricingModel) {
    case 'per_trip':
      totalCost = rate;
      break;
    case 'per_person':
      totalCost = rate * totalPax;
      break;
    case 'per_km':
      totalCost = rate * (Number(distanceKm) || 0);
      break;
    case 'per_day':
    default:
      totalCost = rate * Math.max(1, Number(days) || 1);
      break;
  }

  const fxRate = getFxRate(sourceCurrency, quoteCurrency, orgFxOverrides) ?? 1;
  const totalCostInQuoteCurrency = totalCost * fxRate;

  // Capacity warning — if party exceeds vehicle capacity, the operator
  // probably needs a second vehicle. Not a hard block, just a heads-up.
  const warnings = [];
  const capacity = Number(transport.capacity) || 0;
  if (capacity > 0 && totalPax > capacity) {
    const vehiclesNeeded = Math.ceil(totalPax / capacity);
    warnings.push(
      `${transport.name}: capacity is ${capacity}, party is ${totalPax}. May need ${vehiclesNeeded} vehicles.`
    );
  }

  return {
    sourceCurrency,
    quoteCurrency,
    fxRate,
    totalCost,
    totalCostInQuoteCurrency,
    pricingModel: transport.pricingModel || 'per_day',
    days: Math.max(1, Number(days) || 1),
    distanceKm: Number(distanceKm) || 0,
    warnings,
  };
}
