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

// Last-resort table expressed against USD (1 USD = N currency). Used only
// when the live-rate fetch hasn't succeeded yet AND the org has no override.
// Keep this current-ish so a cold start with a dead upstream still produces
// sane quotes; the live cache below is the real source of truth.
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

// Live cache populated by startFxRefresh(). Same shape as USD_BASE — a
// flat "currency -> units per 1 USD" map. Empty until the first fetch
// succeeds; getFxRate falls through to USD_BASE in the interim.
let liveRates = {};
let liveRatesFetchedAt = null;

const FX_PROVIDER_URL = 'https://open.er-api.com/v6/latest/USD';
const FX_REFRESH_MS = 12 * 60 * 60 * 1000; // 12h — provider updates daily
const FX_FETCH_TIMEOUT_MS = 10_000;

async function fetchLiveRates() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FX_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(FX_PROVIDER_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.result !== 'success' || !data.rates || typeof data.rates !== 'object') {
      throw new Error(`Bad payload: result=${data.result}`);
    }
    liveRates = data.rates;
    liveRatesFetchedAt = new Date();
    console.log(`[fx] Live rates refreshed (${Object.keys(liveRates).length} currencies)`);
  } catch (err) {
    // Keep whatever's already cached; USD_BASE remains the last-resort floor.
    console.warn(`[fx] Live-rate fetch failed: ${err.message}. Using ${liveRatesFetchedAt ? 'last cached rates' : 'hardcoded fallback'}.`);
  } finally {
    clearTimeout(timer);
  }
}

// Kick off an initial fetch and a recurring refresh. Idempotent — calling
// twice would double-schedule, so server startup calls this once.
let refreshTimer = null;
export function startFxRefresh() {
  if (refreshTimer) return;
  fetchLiveRates();                                        // boot fetch (non-blocking)
  refreshTimer = setInterval(fetchLiveRates, FX_REFRESH_MS);
  if (refreshTimer.unref) refreshTimer.unref();            // don't hold the event loop open in tests
}

export function getLiveRatesStatus() {
  return {
    fetchedAt: liveRatesFetchedAt,
    count: Object.keys(liveRates).length,
  };
}

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

  // Precedence: org override > live cache > hardcoded floor. Built bottom-up
  // so spreads later in the chain win on key collision.
  const merged = { ...USD_BASE, ...liveRates, ...orgOverrides };
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
