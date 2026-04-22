// FX conversion utility.
//
// Rates are expressed as "1 unit of SOURCE = N units of TARGET" where TARGET
// is the quote's currency. We keep a conservative default table for common
// East African pairs; each organization can override via `Organization.defaults.fxRates`.
//
// The table is shallow on purpose — operators quote to tourists in a handful
// of currencies (USD, EUR, GBP, KES, TZS, UGX). If an unexpected pair is
// encountered the resolver logs and falls back to treating source == target
// (no conversion), so a missing rate never silently multiplies.

// Base table expressed against USD (1 USD = N currency). Updated manually —
// operators should keep Organization.fxRates current if they care about exact
// margins. Treat these as "good enough for quotes pending a book-rate update."
const USD_BASE = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  KES: 129,
  TZS: 2540,
  UGX: 3730,
  RWF: 1370,
  ZAR: 18.4,
};

// Returns "1 unit of `from` = N units of `to`" using org override first,
// then the USD-base table. Returns null if either currency is unknown.
export function getFxRate(from, to, orgOverrides = {}) {
  if (!from || !to) return null;
  const src = String(from).toUpperCase();
  const tgt = String(to).toUpperCase();
  if (src === tgt) return 1;

  // Direct override on the org: "1 KES = ? USD" lookup
  // org stores rates as "1 KEY = fxRates[KEY] units of org.defaults.currency"
  // We don't know which currency the override targets here — callers pass
  // overrides as a pair-lookup table { "KES->USD": 0.0078 } OR as a base-USD
  // map like the default. Support both for flexibility.
  const pairKey = `${src}->${tgt}`;
  if (orgOverrides[pairKey] != null) return Number(orgOverrides[pairKey]) || null;

  const merged = { ...USD_BASE, ...orgOverrides };
  const srcPerUsd = merged[src];
  const tgtPerUsd = merged[tgt];
  if (srcPerUsd == null || tgtPerUsd == null) return null;

  // 1 SRC = (1 / srcPerUsd) USD = (1 / srcPerUsd) * tgtPerUsd TGT
  return tgtPerUsd / srcPerUsd;
}

// Convert `amount` from `from` currency to `to` currency. If the rate is
// unavailable, logs once and returns the original amount unchanged — safer
// than zeroing the line and hiding it from the operator.
export function convert(amount, from, to, orgOverrides = {}) {
  if (!amount) return 0;
  const rate = getFxRate(from, to, orgOverrides);
  if (rate == null) {
    console.warn(`[fx] No rate for ${from} -> ${to}; returning unconverted amount`);
    return Number(amount);
  }
  return Number(amount) * rate;
}

// Snapshot the rates used for a quote so a later FX move doesn't rewrite
// historic totals. Returns a map keyed by source currency, valued as
// "1 source unit in `to` currency".
export function snapshotRates(sourceCurrencies, to, orgOverrides = {}) {
  const snap = {};
  for (const src of sourceCurrencies) {
    const rate = getFxRate(src, to, orgOverrides);
    if (rate != null) snap[src] = rate;
  }
  return snap;
}

export { USD_BASE };
