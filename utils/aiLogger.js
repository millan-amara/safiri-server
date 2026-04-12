import AiUsageLog from '../models/AiUsageLog.js';

// Hardcoded cost estimates per endpoint (USD).
// These are approximations based on token usage — update as Claude pricing changes.
const ENDPOINT_COSTS = {
  'draft-itinerary':        0.08,
  'generate-all-narratives': 0.05,
  'generate-narrative':     0.02,
  'deal-summary':           0.01,
  'draft-email':            0.01,
  'suggest-route':          0.01,
  'map-columns':            0.01,
};

/**
 * Middleware factory — returns a middleware that logs every AI call to AiUsageLog.
 *
 * Usage:
 *   router.post('/draft-itinerary', checkAiItineraryQuota, logAiCall('draft-itinerary'), handler)
 *
 * Works by:
 * 1. Intercepting res.json() to capture the response payload (for error messages)
 * 2. Attaching a res.on('finish') listener that writes the log after the response is sent
 *
 * The write is fire-and-forget — a log failure never affects the API response.
 *
 * @param {string} endpoint - One of the keys in ENDPOINT_COSTS
 */
export function logAiCall(endpoint) {
  const estimatedCostUsd = ENDPOINT_COSTS[endpoint] ?? 0;

  return (req, res, next) => {
    // Intercept res.json to capture the response body before it's sent.
    // We need this to extract errorMessage on failure paths.
    let capturedBody = null;
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      capturedBody = data;
      return originalJson(data);
    };

    res.on('finish', () => {
      const success = res.statusCode < 400;
      const errorMessage = success ? null : (capturedBody?.message ?? `HTTP ${res.statusCode}`);

      // Fire-and-forget — never block or throw to the caller
      AiUsageLog.create({
        organizationId: req.organizationId,
        userId: req.user?._id,
        endpoint,
        estimatedCostUsd,
        success,
        errorMessage,
      }).catch((err) => {
        console.error('[aiLogger] Failed to write usage log:', err.message);
      });
    });

    next();
  };
}
