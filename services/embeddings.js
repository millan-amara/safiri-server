// Voyage AI embedding client.
//
// Used by Pass 3 of /api/search to enable "vibe" matching — operator queries
// like "luxury tented camp" or "kid-friendly lodge" that have no exact-text
// match in the hotel record but should still surface relevant inventory.
//
// We use voyage-3-lite (512 dims, ~$0.02/1M tokens). The dimensionality is
// stored alongside the vector on each Hotel doc so we can rotate models in
// the future without breaking existing data.
//
// Direction matters: pass `inputType: 'query'` for the operator's question
// and `'document'` when embedding a partner record. Voyage's models are
// asymmetric — using the wrong direction tanks recall noticeably.

import crypto from 'node:crypto';

export const EMBEDDING_MODEL = 'voyage-3-lite';
export const EMBEDDING_DIMS = 512;
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const BATCH_SIZE = 128;     // Voyage caps batch input at 128 texts per call.
const MAX_INPUT_CHARS = 2000;  // Plenty for hotel descriptions; keeps token cost flat.

function trim(s) {
  if (!s || typeof s !== 'string') return '';
  if (s.length <= MAX_INPUT_CHARS) return s;
  return s.slice(0, MAX_INPUT_CHARS);
}

/**
 * Build the canonical embedding source text for a hotel. Stable order so the
 * hash is deterministic — re-embed only fires when content actually changed.
 *
 * Includes everything an operator might match against: name, type (with the
 * underscore normalized so "tented camp" matches), destination, location,
 * description, amenities, tags. Rate-list contents are deliberately left out
 * — those describe pricing, not the property's character.
 */
export function buildHotelEmbeddingSource(hotel) {
  if (!hotel) return '';
  const parts = [];
  if (hotel.name) parts.push(hotel.name);
  if (hotel.type) parts.push(`type: ${String(hotel.type).replace(/_/g, ' ')}`);
  if (hotel.stars) parts.push(`${hotel.stars} star`);
  if (hotel.destination) parts.push(`destination: ${hotel.destination}`);
  if (hotel.location) parts.push(`location: ${hotel.location}`);
  if (hotel.description) parts.push(hotel.description);
  if (hotel.amenities?.length) parts.push(`amenities: ${hotel.amenities.join(', ')}`);
  if (hotel.tags?.length) parts.push(`tags: ${hotel.tags.join(', ')}`);
  return trim(parts.join('\n'));
}

/**
 * Activity embedding source — what would an operator match against?
 * Name, destination, description, duration, season, tags, minimum age, notes.
 * Pricing is excluded since it doesn't describe the activity's character.
 */
export function buildActivityEmbeddingSource(activity) {
  if (!activity) return '';
  const parts = [];
  if (activity.name) parts.push(activity.name);
  if (activity.destination) parts.push(`destination: ${activity.destination}`);
  if (activity.description) parts.push(activity.description);
  if (activity.duration) parts.push(`${activity.duration} hours`);
  if (activity.season && activity.season !== 'all') parts.push(`${activity.season} season`);
  if (activity.minimumAge) parts.push(`minimum age: ${activity.minimumAge}`);
  if (activity.tags?.length) parts.push(`tags: ${activity.tags.join(', ')}`);
  if (activity.notes) parts.push(activity.notes);
  return trim(parts.join('\n'));
}

/**
 * Transport embedding source — name, type (normalized), route/zone, served
 * destinations, capacity, pricing model, notes. Type underscores are flattened
 * so "4x4" / "minibus" / "helicopter" match phrasing variants.
 */
export function buildTransportEmbeddingSource(transport) {
  if (!transport) return '';
  const parts = [];
  if (transport.name) parts.push(transport.name);
  if (transport.type) parts.push(`type: ${String(transport.type).replace(/_/g, ' ')}`);
  if (transport.capacity) parts.push(`${transport.capacity} pax capacity`);
  if (transport.routeOrZone) parts.push(`route: ${transport.routeOrZone}`);
  if (transport.destinations?.length) parts.push(`destinations: ${transport.destinations.join(', ')}`);
  if (transport.pricingModel) parts.push(`pricing: ${transport.pricingModel}`);
  if (transport.notes) parts.push(transport.notes);
  return trim(parts.join('\n'));
}

export function hashSource(source) {
  return crypto.createHash('sha1').update(source || '').digest('hex');
}

async function callVoyage(texts, inputType) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY not configured');

  const response = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      input_type: inputType, // 'query' for operator search; 'document' for partner records
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  // Voyage returns vectors in input order via the `index` field; keep that
  // mapping rather than trusting array position.
  const vectors = new Array(texts.length).fill(null);
  for (const item of data.data || []) {
    if (Number.isInteger(item.index) && Array.isArray(item.embedding)) {
      vectors[item.index] = item.embedding;
    }
  }
  return {
    vectors,
    totalTokens: data.usage?.total_tokens || 0,
  };
}

/**
 * Embed a single piece of text (operator query or single document).
 * Returns { vector, totalTokens }.
 */
export async function embedText(text, { inputType = 'query' } = {}) {
  const trimmed = trim(text);
  if (!trimmed) return { vector: null, totalTokens: 0 };
  const { vectors, totalTokens } = await callVoyage([trimmed], inputType);
  return { vector: vectors[0], totalTokens };
}

// Generic re-embed helper. Hash-gated so it's safe to call on every save;
// failures are logged, not thrown. Caller invokes the kind-specific wrapper
// below (ensureHotelEmbedding / ensureActivityEmbedding / ensureTransportEmbedding).
async function ensureEmbedding({ doc, model, buildSource, label }) {
  if (!doc?._id) return;
  const source = buildSource(doc);
  if (!source) return;
  const hash = hashSource(source);

  // Re-fetch meta so we skip if nothing relevant changed (the doc passed in
  // may be lean and not carry embedding metadata).
  const meta = await model.findById(doc._id)
    .select('embeddingV1SourceHash embeddingV1Model')
    .lean();
  if (meta?.embeddingV1SourceHash === hash && meta?.embeddingV1Model === EMBEDDING_MODEL) {
    return;
  }

  try {
    const { vector } = await embedText(source, { inputType: 'document' });
    if (!vector) return;
    await model.updateOne(
      { _id: doc._id },
      {
        $set: {
          embeddingV1: vector,
          embeddingV1Model: EMBEDDING_MODEL,
          embeddingV1SourceHash: hash,
          embeddingV1UpdatedAt: new Date(),
        },
      }
    );
  } catch (err) {
    console.error(`[embeddings] Failed to embed ${label} ${doc._id}:`, err.message);
  }
}

/**
 * Re-embed a single hotel if its source content has changed. Fire-and-forget.
 */
export async function ensureHotelEmbedding(hotelDoc) {
  // Lazy import to avoid pulling models into modules that only need the
  // raw embedText/embedDocuments primitives.
  const { default: Hotel } = await import('../models/Hotel.js');
  return ensureEmbedding({ doc: hotelDoc, model: Hotel, buildSource: buildHotelEmbeddingSource, label: 'hotel' });
}

/**
 * Re-embed a single activity. Same fire-and-forget semantics as hotel.
 */
export async function ensureActivityEmbedding(activityDoc) {
  const { default: Activity } = await import('../models/Activity.js');
  return ensureEmbedding({ doc: activityDoc, model: Activity, buildSource: buildActivityEmbeddingSource, label: 'activity' });
}

/**
 * Re-embed a single transport. Same fire-and-forget semantics as hotel.
 */
export async function ensureTransportEmbedding(transportDoc) {
  const { default: Transport } = await import('../models/Transport.js');
  return ensureEmbedding({ doc: transportDoc, model: Transport, buildSource: buildTransportEmbeddingSource, label: 'transport' });
}

/**
 * Embed many documents in batches of up to 128. Returns parallel arrays so
 * callers can pair results back to their inputs by position.
 */
export async function embedDocuments(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { vectors: [], totalTokens: 0 };
  }
  const trimmed = texts.map(trim);
  const out = new Array(trimmed.length).fill(null);
  let totalTokens = 0;

  for (let i = 0; i < trimmed.length; i += BATCH_SIZE) {
    const batch = trimmed.slice(i, i + BATCH_SIZE);
    // Skip empty strings — Voyage rejects them and one bad input fails the
    // whole batch. We keep them as `null` in the output array.
    const indices = [];
    const inputs = [];
    batch.forEach((t, j) => { if (t) { indices.push(i + j); inputs.push(t); } });
    if (!inputs.length) continue;

    const { vectors, totalTokens: batchTokens } = await callVoyage(inputs, 'document');
    indices.forEach((origIdx, k) => { out[origIdx] = vectors[k]; });
    totalTokens += batchTokens;
  }

  return { vectors: out, totalTokens };
}
