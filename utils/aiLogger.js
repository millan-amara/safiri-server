import AiUsageLog from '../models/AiUsageLog.js';

// USD per million tokens. Cache write = 1.25× input (5min TTL); cache read = 0.1× input.
// Source: Anthropic pricing for Sonnet 4.6 / Haiku 4.5.
const PRICING = {
  'claude-sonnet-4-6':           { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5':            { input: 1.0, output: 5.0,  cacheRead: 0.10, cacheWrite: 1.25 },
  // Legacy IDs — kept so logs from any in-flight call during a deploy still cost correctly.
  'claude-haiku-4-5-20251001':   { input: 1.0, output: 5.0,  cacheRead: 0.10, cacheWrite: 1.25 },
  'claude-sonnet-4-20250514':    { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
};

function costFromUsage({ model, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }) {
  const r = PRICING[model];
  if (!r) {
    console.warn(`[aiLogger] Unknown model in usage record: ${model}`);
    return 0;
  }
  return (
    inputTokens * r.input +
    outputTokens * r.output +
    cacheReadInputTokens * r.cacheRead +
    cacheCreationInputTokens * r.cacheWrite
  ) / 1_000_000;
}

/**
 * Attach usage data captured from a single Claude API call to the request.
 *
 * Multiple calls per request (e.g. draft-itinerary's Haiku extractor + main
 * Sonnet call) accumulate into req._aiUsage so each gets its own log row.
 */
export function recordAiUsage(req, usage) {
  if (!req._aiUsage) req._aiUsage = [];
  req._aiUsage.push(usage);
}

/**
 * Middleware factory — writes one AiUsageLog row per Claude call captured via
 * recordAiUsage(), after the response finishes.
 *
 * If no calls were captured (failure before reaching Claude, or a missing
 * recordAiUsage in a handler), still writes a single row with 0 tokens so the
 * endpoint-level call rate stays accurate.
 */
export function logAiCall(endpoint) {
  return (req, res, next) => {
    let capturedBody = null;
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      capturedBody = data;
      return originalJson(data);
    };

    res.on('finish', () => {
      const success = res.statusCode < 400;
      const errorMessage = success ? null : (capturedBody?.message ?? `HTTP ${res.statusCode}`);
      const calls = req._aiUsage?.length ? req._aiUsage : [null];

      for (const usage of calls) {
        AiUsageLog.create({
          organizationId: req.organizationId,
          userId: req.user?._id,
          endpoint,
          success,
          errorMessage,
          model: usage?.model || null,
          inputTokens: usage?.inputTokens || 0,
          outputTokens: usage?.outputTokens || 0,
          cacheReadInputTokens: usage?.cacheReadInputTokens || 0,
          cacheCreationInputTokens: usage?.cacheCreationInputTokens || 0,
          estimatedCostUsd: usage ? costFromUsage(usage) : 0,
        }).catch((err) => {
          console.error('[aiLogger] Failed to write usage log:', err.message);
        });
      }
    });

    next();
  };
}
