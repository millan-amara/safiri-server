// Natural-language partner search.
//
// POST /api/search { query, type? } → { parsed, results, warnings }
//
// The parser (Haiku) extracts a structured spec; the executor runs it
// deterministically against the org's hotel/activity/transport/package
// inventory using the existing pricers. No LLM in the pricing path —
// every total is computed from the operator's own data.

import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { protect } from '../middleware/auth.js';
import { checkAiCredits } from '../middleware/subscription.js';
import { logAiCall, recordAiUsage } from '../utils/aiLogger.js';
import { AI_CREDIT_COST, getPlan } from '../config/plans.js';
import { parseQuery } from '../services/searchParser.js';
import { executeSearch, executeLookup, executeDiagnostic } from '../services/searchExecutor.js';
import { generateRationales, generateLookupAnswer } from '../services/searchRationale.js';
import { logSearch } from '../utils/searchLogger.js';

const router = Router();
router.use(protect);

// Same plan-aware policy as /api/ai — Starter 5/min, Pro 10, Business 20, Enterprise 30.
// Keyed by org so shared office IPs don't pool limits across orgs.
const searchRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => getPlan(req.organization?.plan).aiRateLimitPerMin,
  keyGenerator: (req, res) => req.organizationId?.toString() || ipKeyGenerator(req, res),
  message: { message: 'Too many search requests. Please slow down and try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});
router.use(searchRateLimiter);

router.post(
  '/',
  checkAiCredits(AI_CREDIT_COST.search),
  logAiCall('search'),
  async (req, res) => {
    const t0 = Date.now();
    let effectiveParsed = null;
    let query = '';

    // Build a per-request closure so each return point logs with one line.
    // Fire-and-forget — never blocks the response, never throws.
    const log = (outcome, opts = {}) => logSearch({
      organization: req.organizationId,
      user: req.user?._id,
      query,
      intent: opts.intent ?? effectiveParsed?.intent ?? 'search',
      parsed: opts.parsed ?? effectiveParsed,
      outcome,
      resultCount: opts.resultCount ?? 0,
      // "Attempted" signal: the route would have tried the vector path when
      // mustHave > 0 and intent=search. We don't (yet) thread the real
      // succeeded/fell-back flag back from the executor — proxy is good enough.
      vectorPathUsed: !!opts.vectorPathUsed,
      ms: Date.now() - t0,
    });

    try {
      query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      if (!query) return res.status(400).json({ message: 'Query is required.' });
      if (query.length > 500) return res.status(400).json({ message: 'Query too long (max 500 chars).' });

      const today = new Date().toISOString().slice(0, 10);
      const { parsed, usage } = await parseQuery({ query, today });
      recordAiUsage(req, usage);

      // If the caller explicitly forced a type (e.g., a "search activities only"
      // toggle in the UI), honor it over what the model picked.
      const forcedType = ['hotel', 'activity', 'transport', 'package'].includes(req.body?.type)
        ? req.body.type
        : null;
      effectiveParsed = forcedType ? { ...parsed, type: forcedType } : parsed;

      // ── Lookup intent: Q&A about a specific named partner ────────────────
      // The parser sets intent='lookup' when the operator is asking ABOUT a
      // partner ("What's Serena's cancellation policy?") rather than searching
      // for inventory. We resolve the partner, pull topic-specific data, and
      // generate the answer in this same call so the operator gets one
      // response with the answer in it. Costs 2 credits total (parser + answer).
      if (effectiveParsed.intent === 'lookup' && effectiveParsed.subjectName) {
        const lookupResult = await executeLookup({
          parsed: effectiveParsed,
          organizationId: req.organizationId,
        });

        // Multiple matches — return slim candidates and ask the operator to pick.
        if (!lookupResult.lookup && lookupResult.candidates.length > 0) {
          log('lookup_candidates', { resultCount: lookupResult.candidates.length });
          return res.json({
            intent: 'lookup',
            parsed: effectiveParsed,
            lookup: null,
            candidates: lookupResult.candidates,
            answer: null,
          });
        }

        // No matches — clarification.
        if (!lookupResult.lookup && lookupResult.candidates.length === 0) {
          log('clarification');
          return res.json({
            intent: 'lookup',
            parsed: effectiveParsed,
            lookup: null,
            candidates: [],
            answer: null,
            needsClarification: {
              fields: ['subjectName'],
              prompt: lookupResult.message || `No partner matched "${effectiveParsed.subjectName}".`,
            },
          });
        }

        // Single match — generate the answer. If Haiku errors, return the
        // structured lookup data anyway so the UI can render fallback.
        let answer = null;
        try {
          const r = await generateLookupAnswer({
            query, parsed: effectiveParsed, lookup: lookupResult.lookup,
          });
          if (r.usage) recordAiUsage(req, r.usage);
          answer = r.answer;
        } catch (err) {
          console.error('[search] lookup answer generation failed:', err.message);
        }

        log('lookup_answer', { resultCount: 1 });
        return res.json({
          intent: 'lookup',
          parsed: effectiveParsed,
          lookup: lookupResult.lookup,
          candidates: [],
          answer,
        });
      }

      // ── Diagnostic intent: inventory audit ───────────────────────────────
      // Deterministic Mongo queries — no pricing, no LLM ranking. Returns a
      // list of partners with the issue label so the UI can render a "fix this"
      // action. Useful for "hotels missing rate lists", "rate lists expiring",
      // etc.
      if (effectiveParsed.intent === 'diagnostic' && effectiveParsed.diagnostic) {
        const diag = await executeDiagnostic({
          parsed: effectiveParsed,
          organizationId: req.organizationId,
        });
        log(diag.items.length > 0 ? 'diagnostic_items' : 'diagnostic_clean', { resultCount: diag.items.length });
        return res.json({
          intent: 'diagnostic',
          parsed: effectiveParsed,
          diagnostic: diag.diagnostic,
          label: diag.label,
          items: diag.items,
          totalCount: diag.totalCount,
          canonical: diag.canonical,
          warnings: diag.warnings,
        });
      }

      // ── Search intent: standard inventory search ─────────────────────────
      // Bail with a clarification prompt when there's no narrowing signal —
      // i.e. no destination AND no qualitative must-haves. A bare type alone
      // ("any hotel") would dump the whole inventory, which is worse than
      // asking one question. Type+mustHave or type+destination are both fine.
      const noNarrowingSignal =
        !effectiveParsed.destinationName &&
        !(effectiveParsed.mustHave?.length);
      if (noNarrowingSignal) {
        log('clarification');
        return res.json({
          intent: 'search',
          parsed: effectiveParsed,
          results: [],
          needsClarification: {
            fields: ['destinationName'],
            prompt: effectiveParsed.type
              ? `Which destination? E.g. "${effectiveParsed.type} in Maasai Mara" or add a qualifier like "luxury" / "tented".`
              : 'What kind of partner are you looking for, and where? E.g. "tented camp in Maasai Mara".',
          },
          warnings: [],
        });
      }

      const { results, destination, canonical, quoteCurrency, warnings } = await executeSearch({
        parsed: effectiveParsed,
        organizationId: req.organizationId,
        query,
      });

      log(results.length > 0 ? 'results' : 'no_results', {
        resultCount: results.length,
        vectorPathUsed: !!effectiveParsed.mustHave?.length,
      });
      return res.json({
        intent: 'search',
        parsed: effectiveParsed,
        destination,           // resolved Destination doc summary, or null
        canonical,             // canonical destination name actually searched
        quoteCurrency,
        results,
        warnings,
      });
    } catch (err) {
      const status = err.status || 500;
      const message = status === 500 ? 'Search failed. Please try again.' : err.message;
      console.error('[search] failed:', err);
      log('error');
      return res.status(status).json({ message });
    }
  }
);

// ─── RATIONALE (Pass 2) ───────────────────────────────────────────────────────
// Optional follow-up: generate one-line operator-friendly rationales for the
// top 3 results. Called by the client after the main search returns so the
// structured results render immediately and rationale streams in second.
//
// LLM is forbidden from inventing prices — it only paraphrases the
// server-computed numbers we hand it. Mismatched ids in the response are
// dropped so a hallucinated rationale can never be attached to the wrong card.

router.post(
  '/rationale',
  checkAiCredits(AI_CREDIT_COST.search),
  logAiCall('search-rationale'),
  async (req, res) => {
    try {
      const { query, parsed, results } = req.body || {};
      if (!Array.isArray(results) || results.length === 0) {
        return res.json({ rationales: [] });
      }
      if (results.length > 10) {
        return res.status(400).json({ message: 'Too many results (max 10).' });
      }

      const { rationales, usage } = await generateRationales({ query, parsed, results });
      if (usage) recordAiUsage(req, usage);
      return res.json({ rationales });
    } catch (err) {
      const status = err.status || 500;
      const message = status === 500 ? 'Rationale generation failed.' : err.message;
      console.error('[search/rationale] failed:', err);
      return res.status(status).json({ message });
    }
  }
);

export default router;
