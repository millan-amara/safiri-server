// Backfill embeddings for every active hotel, activity, and transport, and
// (idempotently) ensure the Atlas $vectorSearch indexes exist.
//
// Usage:
//   node scripts/backfillEmbeddings.js                       # all three targets
//   node scripts/backfillEmbeddings.js --only=hotels         # one target only
//   node scripts/backfillEmbeddings.js --only=activities,transport
//   node scripts/backfillEmbeddings.js --org=<id>            # scope to single org
//   node scripts/backfillEmbeddings.js --force               # re-embed even when hash matches
//   node scripts/backfillEmbeddings.js --index-only          # just (re)create the Atlas indexes
//
// Safe to run repeatedly: skips records whose source-text hash hasn't changed.

import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Hotel from '../models/Hotel.js';
import Activity from '../models/Activity.js';
import Transport from '../models/Transport.js';
import {
  embedDocuments,
  buildHotelEmbeddingSource,
  buildActivityEmbeddingSource,
  buildTransportEmbeddingSource,
  hashSource,
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
} from '../services/embeddings.js';

// One descriptor per indexed partner type. Each carries the model, the source
// builder, the Atlas index name, and the projection used to fetch only the
// fields the source builder reads (keeps the backfill memory-light).
const TARGETS = [
  {
    label: 'hotels',
    model: Hotel,
    buildSource: buildHotelEmbeddingSource,
    indexName: 'hotel_embeddings_v1',
    projection: 'name type stars destination location description amenities tags embeddingV1SourceHash embeddingV1Model',
  },
  {
    label: 'activities',
    model: Activity,
    buildSource: buildActivityEmbeddingSource,
    indexName: 'activity_embeddings_v1',
    projection: 'name destination description duration season tags minimumAge notes embeddingV1SourceHash embeddingV1Model',
  },
  {
    label: 'transport',
    model: Transport,
    buildSource: buildTransportEmbeddingSource,
    indexName: 'transport_embeddings_v1',
    projection: 'name type capacity routeOrZone destinations pricingModel notes embeddingV1SourceHash embeddingV1Model',
  },
];

function parseArgs(argv) {
  const args = { force: false, indexOnly: false, org: null, only: null };
  for (const a of argv.slice(2)) {
    if (a === '--force') args.force = true;
    else if (a === '--index-only') args.indexOnly = true;
    else if (a.startsWith('--org=')) args.org = a.slice('--org='.length);
    else if (a.startsWith('--only=')) {
      args.only = a.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return args;
}

// Idempotently create the Atlas Vector Search index for one target. Requires
// MongoDB Atlas; against self-hosted Mongo this throws.
async function ensureVectorIndex(target) {
  const coll = target.model.collection;
  let existing = [];
  try {
    existing = await coll.listSearchIndexes().toArray();
  } catch (err) {
    throw new Error(
      `Could not list search indexes on ${coll.collectionName} (this requires Atlas, not self-hosted Mongo): ${err.message}`
    );
  }

  const found = existing.find(i => i.name === target.indexName);
  if (found) {
    console.log(`✓ Vector index '${target.indexName}' already exists on ${coll.collectionName} (status: ${found.status || 'unknown'}).`);
    return;
  }

  console.log(`Creating vector index '${target.indexName}' on ${coll.collectionName}.embeddingV1 (${EMBEDDING_DIMS} dims, cosine)…`);
  await coll.createSearchIndex({
    name: target.indexName,
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
  console.log(`✓ Index creation requested for ${target.indexName}. Atlas will mark it READY in 1–2 minutes.`);
}

async function backfillTarget(target, { force, org }) {
  const filter = { isActive: true };
  if (org) filter.organization = new mongoose.Types.ObjectId(org);

  const docs = await target.model.find(filter).select(target.projection).lean();
  console.log(`[${target.label}] Loaded ${docs.length} active record${docs.length === 1 ? '' : 's'}${org ? ` in org ${org}` : ''}.`);

  const work = [];
  for (const d of docs) {
    const source = target.buildSource(d);
    if (!source) continue;
    const hash = hashSource(source);
    const stale = force || d.embeddingV1SourceHash !== hash || d.embeddingV1Model !== EMBEDDING_MODEL;
    if (stale) work.push({ id: d._id, source, hash });
  }

  console.log(`[${target.label}] ${work.length} record${work.length === 1 ? '' : 's'} need re-embedding.`);
  if (!work.length) return;

  const t0 = Date.now();
  const { vectors, totalTokens } = await embedDocuments(work.map(w => w.source));
  console.log(`[${target.label}] Embedded ${vectors.filter(Boolean).length} doc${vectors.filter(Boolean).length === 1 ? '' : 's'} (${totalTokens} tokens) in ${(Date.now() - t0) / 1000}s.`);

  const now = new Date();
  let written = 0;
  for (let i = 0; i < work.length; i++) {
    const vec = vectors[i];
    if (!vec) continue;
    await target.model.updateOne(
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
  console.log(`✓ [${target.label}] Wrote ${written} embedding${written === 1 ? '' : 's'}.`);
}

async function main() {
  const args = parseArgs(process.argv);

  // Apply --only filter.
  const targets = args.only
    ? TARGETS.filter(t => args.only.includes(t.label))
    : TARGETS;
  if (!targets.length) {
    console.error(`No matching targets for --only=${args.only?.join(',')}. Valid: ${TARGETS.map(t => t.label).join(', ')}.`);
    process.exit(1);
  }

  await connectDB();
  try {
    for (const target of targets) {
      await ensureVectorIndex(target);
    }
    if (!args.indexOnly) {
      for (const target of targets) {
        await backfillTarget(target, { force: args.force, org: args.org });
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
