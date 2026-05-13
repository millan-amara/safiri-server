// Fire-and-forget logger for /api/search calls.
//
// The route handler builds one log entry per response and calls logSearch()
// just before res.json(). Failures are swallowed (search results matter more
// than the audit row) and the write is unawaited so it doesn't block the
// response.

import SearchLog from '../models/SearchLog.js';

function summarizeParsed(parsed) {
  if (!parsed) return {};
  return {
    type: parsed.type || null,
    destinationName: parsed.destinationName || null,
    propertyType: parsed.propertyType?.length ? parsed.propertyType : undefined,
    subjectName: parsed.subjectName || null,
    lookupTopic: parsed.lookupTopic || null,
    diagnostic: parsed.diagnostic || null,
    adults: parsed.adults ?? null,
    childrenCount: Array.isArray(parsed.children) ? parsed.children.length : 0,
    budgetMax: parsed.budgetMax ?? null,
    currency: parsed.currency || null,
    boardBasis: parsed.boardBasis || null,
    clientType: parsed.clientType || null,
    nationality: parsed.nationality || null,
    // Cap at 10 entries — anything more is noise, and we want the doc small.
    mustHave: Array.isArray(parsed.mustHave) ? parsed.mustHave.slice(0, 10) : [],
    dateFrom: parsed.dateRange?.from || null,
    dateTo: parsed.dateRange?.to || null,
  };
}

/**
 * Write one log entry. Never throws; never blocks (caller doesn't await).
 *
 * @param {object} args
 * @param {ObjectId} args.organization
 * @param {ObjectId} [args.user]
 * @param {string} args.query - raw operator query
 * @param {string} args.intent - 'search' | 'lookup' | 'diagnostic'
 * @param {object} [args.parsed] - the parser output (will be summarized)
 * @param {string} args.outcome - which branch the route took (see SearchLog enum)
 * @param {number} [args.resultCount]
 * @param {boolean} [args.vectorPathUsed]
 * @param {number} [args.ms] - wall-clock duration in ms
 */
export function logSearch(args) {
  // Don't block — fire and forget. Errors stay in console only; search
  // observability is non-critical.
  SearchLog.create({
    organization: args.organization,
    user: args.user,
    query: String(args.query || '').slice(0, 500),
    intent: args.intent,
    parsed: summarizeParsed(args.parsed),
    outcome: args.outcome,
    resultCount: Number.isFinite(args.resultCount) ? args.resultCount : 0,
    vectorPathUsed: !!args.vectorPathUsed,
    ms: Number.isFinite(args.ms) ? args.ms : 0,
  }).catch(err => {
    console.error('[searchLogger] failed to write log:', err.message);
  });
}
