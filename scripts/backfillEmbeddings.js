// Backfill embeddings for every active hotel and (idempotently) ensure the
// Atlas $vectorSearch index exists.
//
// Usage:
//   node scripts/backfillEmbeddings.js               # backfill all orgs
//   node scripts/backfillEmbeddings.js --org=<id>    # backfill a single org
//   node scripts/backfillEmbeddings.js --force       # re-embed even when hash matches
//   node scripts/backfillEmbeddings.js --index-only  # just (re)create the Atlas index
//
// Safe to run repeatedly: skips hotels whose source text hash hasn't changed.

import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Hotel from '../models/Hotel.js';
import {
  embedDocuments,
  buildHotelEmbeddingSource,
  hashSource,
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
} from '../services/embeddings.js';

const VECTOR_INDEX_NAME = 'hotel_embeddings_v1';

function parseArgs(argv) {
  const args = { force: false, indexOnly: false, org: null };
  for (const a of argv.slice(2)) {
    if (a === '--force') args.force = true;
    else if (a === '--index-only') args.indexOnly = true;
    else if (a.startsWith('--org=')) args.org = a.slice('--org='.length);
  }
  return args;
}

// Idempotently create the Atlas Vector Search index. Requires MongoDB Atlas;
// against a self-hosted Mongo this throws and the operator should disable
// vector search in the executor or move to Atlas.
async function ensureVectorIndex() {
  const coll = Hotel.collection;
  let existing = [];
  try {
    existing = await coll.listSearchIndexes().toArray();
  } catch (err) {
    throw new Error(
      `Could not list search indexes (this requires Atlas, not self-hosted Mongo): ${err.message}`
    );
  }

  const found = existing.find(i => i.name === VECTOR_INDEX_NAME);
  if (found) {
    console.log(`✓ Vector index '${VECTOR_INDEX_NAME}' already exists (status: ${found.status || 'unknown'}).`);
    return;
  }

  console.log(`Creating vector index '${VECTOR_INDEX_NAME}' on hotels.embeddingV1 (${EMBEDDING_DIMS} dims, cosine)…`);
  await coll.createSearchIndex({
    name: VECTOR_INDEX_NAME,
    type: 'vectorSearch',
    definition: {
      fields: [
        {
          type: 'vector',
          path: 'embeddingV1',
          numDimensions: EMBEDDING_DIMS,
          similarity: 'cosine',
        },
        // organization is the hard tenancy filter — every search query must
        // pass this through so a vector-search hit can never cross orgs.
        { type: 'filter', path: 'organization' },
        { type: 'filter', path: 'isActive' },
      ],
    },
  });
  console.log(`✓ Index creation requested. Atlas will mark it READY in 1–2 minutes.`);
}

async function backfill({ force, org }) {
  const filter = { isActive: true };
  if (org) filter.organization = new mongoose.Types.ObjectId(org);

  // Pull only the fields we need to compute the source text + the existing
  // hash. The vector itself is `select: false` so Hotel.find() naturally
  // skips it; we don't need to re-pull it here either.
  const hotels = await Hotel.find(filter)
    .select('name type stars destination location description amenities tags embeddingV1SourceHash embeddingV1Model')
    .lean();

  console.log(`Loaded ${hotels.length} active hotel${hotels.length === 1 ? '' : 's'}${org ? ` in org ${org}` : ''}.`);

  // Compute source + hash; build the work list.
  const work = [];
  for (const h of hotels) {
    const source = buildHotelEmbeddingSource(h);
    if (!source) continue;
    const hash = hashSource(source);
    const stale = force
      || h.embeddingV1SourceHash !== hash
      || h.embeddingV1Model !== EMBEDDING_MODEL;
    if (stale) work.push({ id: h._id, source, hash });
  }

  console.log(`${work.length} hotel${work.length === 1 ? '' : 's'} need re-embedding.`);
  if (!work.length) return;

  // Batch-embed via Voyage. embedDocuments handles the 128-batch chunking.
  const t0 = Date.now();
  const { vectors, totalTokens } = await embedDocuments(work.map(w => w.source));
  console.log(`Embedded ${vectors.filter(Boolean).length} doc${vectors.filter(Boolean).length === 1 ? '' : 's'} (${totalTokens} tokens) in ${(Date.now() - t0) / 1000}s.`);

  // Persist vectors. One updateOne per hotel — small writes, the loop is fine
  // at the scale we expect (low thousands max). Run as bulk if this ever bites.
  const now = new Date();
  let written = 0;
  for (let i = 0; i < work.length; i++) {
    const vec = vectors[i];
    if (!vec) continue;
    await Hotel.updateOne(
      { _id: work[i].id },
      {
        $set: {
          embeddingV1: vec,
          embeddingV1Model: EMBEDDING_MODEL,
          embeddingV1SourceHash: work[i].hash,
          embeddingV1UpdatedAt: now,
        },
      }
    );
    written++;
  }
  console.log(`✓ Wrote ${written} embedding${written === 1 ? '' : 's'} to the hotels collection.`);
}

async function main() {
  const args = parseArgs(process.argv);
  await connectDB();
  try {
    await ensureVectorIndex();
    if (!args.indexOnly) {
      await backfill({ force: args.force, org: args.org });
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
