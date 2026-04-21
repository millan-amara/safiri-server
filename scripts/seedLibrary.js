// Bulk-seed the LibraryImage collection by querying Pexels and re-hosting
// the top results on Cloudinary. Run as a one-off from the server dir:
//
//   node scripts/seedLibrary.js              # dry run (prints plan, no writes)
//   node scripts/seedLibrary.js --live       # actually upload
//   node scripts/seedLibrary.js --live --filter=masai
//
// Idempotent: skips any photo whose Pexels ID is already in sourceUrl.
// Pexels License allows commercial redistribution; we store photographer
// credit + the Pexels page URL in credit/sourceUrl fields.

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import LibraryImage from '../models/LibraryImage.js';

dotenv.config();

// ─── Config: what to seed ────────────────────────────────────────────────────
// Each bucket produces one Pexels search + creates up to `count` library images.
// destinationType must match the LibraryImage enum:
//   safari | beach | city | mountain | lake | cultural | adventure | other
const BUCKETS = [
  // ── Kenya safari parks ──────────────────────────────────────────────
  { name: 'Maasai Mara',    query: 'maasai mara safari',        tags: ['maasai mara', 'masai mara', 'mara', 'kenya'],  destinationType: 'safari',   count: 12 },
  { name: 'Maasai Mara landscape', query: 'maasai mara landscape', tags: ['maasai mara', 'landscape', 'kenya'],         destinationType: 'safari',   count: 6 },
  { name: 'Amboseli',       query: 'amboseli kilimanjaro',      tags: ['amboseli', 'kenya'],                           destinationType: 'safari',   count: 10 },
  { name: 'Tsavo',          query: 'tsavo elephants kenya',     tags: ['tsavo', 'kenya'],                              destinationType: 'safari',   count: 8 },
  { name: 'Samburu',        query: 'samburu national reserve',  tags: ['samburu', 'kenya'],                            destinationType: 'safari',   count: 8 },
  { name: 'Lake Nakuru',    query: 'lake nakuru flamingos',     tags: ['nakuru', 'lake nakuru', 'flamingos', 'kenya'], destinationType: 'lake',     count: 8 },
  { name: 'Lake Naivasha',  query: 'lake naivasha kenya',       tags: ['naivasha', 'kenya'],                           destinationType: 'lake',     count: 6 },
  { name: 'Aberdare',       query: 'aberdare national park',    tags: ['aberdare', 'kenya'],                           destinationType: 'safari',   count: 6 },
  { name: 'Hells Gate',     query: 'hells gate national park',  tags: ['hells gate', 'kenya'],                         destinationType: 'adventure',count: 6 },
  { name: 'Nairobi NP',     query: 'nairobi national park',     tags: ['nairobi national park', 'kenya'],              destinationType: 'safari',   count: 6 },

  // ── Tanzania ────────────────────────────────────────────────────────
  { name: 'Serengeti',      query: 'serengeti wildlife',        tags: ['serengeti', 'tanzania'],                       destinationType: 'safari',   count: 12 },
  { name: 'Ngorongoro',     query: 'ngorongoro crater',         tags: ['ngorongoro', 'tanzania'],                      destinationType: 'safari',   count: 10 },
  { name: 'Tarangire',      query: 'tarangire elephants',       tags: ['tarangire', 'tanzania'],                       destinationType: 'safari',   count: 8 },
  { name: 'Lake Manyara',   query: 'lake manyara tanzania',     tags: ['manyara', 'tanzania'],                         destinationType: 'lake',     count: 6 },

  // ── Uganda / Rwanda ─────────────────────────────────────────────────
  { name: 'Bwindi',         query: 'bwindi impenetrable forest',tags: ['bwindi', 'uganda', 'gorilla'],                 destinationType: 'safari',   count: 8 },
  { name: 'Volcanoes NP',   query: 'volcanoes national park rwanda', tags: ['volcanoes', 'rwanda', 'gorilla'],         destinationType: 'mountain', count: 6 },
  { name: 'Queen Elizabeth',query: 'queen elizabeth national park uganda', tags: ['queen elizabeth', 'uganda'],        destinationType: 'safari',   count: 6 },

  // ── Coast ───────────────────────────────────────────────────────────
  { name: 'Diani Beach',    query: 'diani beach kenya',         tags: ['diani', 'beach', 'kenya'],                     destinationType: 'beach',    count: 10 },
  { name: 'Watamu',         query: 'watamu beach kenya',        tags: ['watamu', 'beach', 'kenya'],                    destinationType: 'beach',    count: 8 },
  { name: 'Lamu',           query: 'lamu island kenya',         tags: ['lamu', 'kenya'],                               destinationType: 'cultural', count: 8 },
  { name: 'Zanzibar Stone Town', query: 'stone town zanzibar',  tags: ['zanzibar', 'stone town', 'tanzania'],          destinationType: 'cultural', count: 8 },
  { name: 'Zanzibar beach', query: 'zanzibar beach',            tags: ['zanzibar', 'beach', 'tanzania'],               destinationType: 'beach',    count: 10 },
  { name: 'Mombasa',        query: 'mombasa kenya',             tags: ['mombasa', 'kenya'],                            destinationType: 'city',     count: 6 },

  // ── Cities ──────────────────────────────────────────────────────────
  { name: 'Nairobi',        query: 'nairobi skyline kenya',     tags: ['nairobi', 'kenya'],                            destinationType: 'city',     count: 6 },

  // ── Mountains ───────────────────────────────────────────────────────
  { name: 'Kilimanjaro',    query: 'mount kilimanjaro',         tags: ['kilimanjaro', 'tanzania'],                     destinationType: 'mountain', count: 8 },
  { name: 'Mount Kenya',    query: 'mount kenya snow peak',     tags: ['mount kenya', 'kenya'],                        destinationType: 'mountain', count: 6 },

  // ── Wildlife ────────────────────────────────────────────────────────
  { name: 'Lion',           query: 'lion african savannah',     tags: ['lion', 'wildlife', 'big five'],                destinationType: 'safari',   count: 8 },
  { name: 'Elephant',       query: 'african elephant herd',     tags: ['elephant', 'wildlife', 'big five'],            destinationType: 'safari',   count: 8 },
  { name: 'Leopard',        query: 'leopard tree africa',       tags: ['leopard', 'wildlife', 'big five'],             destinationType: 'safari',   count: 6 },
  { name: 'Rhino',          query: 'black rhino africa',        tags: ['rhino', 'wildlife', 'big five'],               destinationType: 'safari',   count: 6 },
  { name: 'Buffalo',        query: 'african buffalo',           tags: ['buffalo', 'wildlife', 'big five'],             destinationType: 'safari',   count: 5 },
  { name: 'Zebra',          query: 'zebra herd africa',         tags: ['zebra', 'wildlife'],                           destinationType: 'safari',   count: 5 },
  { name: 'Giraffe',        query: 'giraffe savannah',          tags: ['giraffe', 'wildlife'],                         destinationType: 'safari',   count: 5 },
  { name: 'Wildebeest',     query: 'wildebeest migration',      tags: ['wildebeest', 'migration', 'wildlife'],         destinationType: 'safari',   count: 8 },
  { name: 'Cheetah',        query: 'cheetah africa',            tags: ['cheetah', 'wildlife'],                         destinationType: 'safari',   count: 5 },
  { name: 'Hippo',          query: 'hippopotamus africa',       tags: ['hippo', 'wildlife'],                           destinationType: 'safari',   count: 5 },
  { name: 'Gorilla',        query: 'mountain gorilla',          tags: ['gorilla', 'wildlife'],                         destinationType: 'safari',   count: 6 },
  { name: 'Flamingo',       query: 'flamingos africa lake',     tags: ['flamingo', 'wildlife'],                        destinationType: 'lake',     count: 5 },

  // ── Activities ──────────────────────────────────────────────────────
  { name: 'Game drive',     query: 'safari jeep game drive',    tags: ['game drive', 'safari', 'activity'],            destinationType: 'safari',   count: 6 },
  { name: 'Hot air balloon',query: 'hot air balloon safari',    tags: ['balloon safari', 'activity'],                  destinationType: 'adventure',count: 6 },
  { name: 'Bush breakfast', query: 'bush breakfast safari',     tags: ['bush breakfast', 'activity'],                  destinationType: 'safari',   count: 4 },
  { name: 'Sundowner',      query: 'sundowner safari sunset',   tags: ['sundowner', 'activity'],                       destinationType: 'safari',   count: 5 },
  { name: 'Dhow cruise',    query: 'dhow sailing zanzibar',     tags: ['dhow', 'activity'],                            destinationType: 'beach',    count: 5 },
  { name: 'Snorkeling',     query: 'snorkeling coral reef',     tags: ['snorkeling', 'activity'],                      destinationType: 'beach',    count: 4 },
  { name: 'Diving',         query: 'scuba diving coral',        tags: ['diving', 'activity'],                          destinationType: 'beach',    count: 4 },
  { name: 'Maasai culture', query: 'maasai warriors traditional',tags: ['maasai', 'cultural', 'activity'],             destinationType: 'cultural', count: 6 },
  { name: 'Bush walk',      query: 'walking safari africa',     tags: ['walking safari', 'activity'],                  destinationType: 'adventure',count: 4 },
  { name: 'Gorilla trek',   query: 'gorilla trekking',          tags: ['gorilla trekking', 'activity'],                destinationType: 'adventure',count: 4 },
  { name: 'Safari lodge',   query: 'luxury safari lodge veranda',tags: ['safari lodge', 'accommodation'],              destinationType: 'safari',   count: 6 },
  { name: 'Tented camp',    query: 'luxury tented camp safari', tags: ['tented camp', 'accommodation'],                destinationType: 'safari',   count: 5 },

  // ── Atmosphere / filler ─────────────────────────────────────────────
  { name: 'Savannah sunset',query: 'african savannah sunset',   tags: ['sunset', 'savannah', 'atmosphere'],            destinationType: 'safari',   count: 6 },
  { name: 'Acacia tree',    query: 'acacia tree africa',        tags: ['acacia', 'atmosphere'],                        destinationType: 'safari',   count: 4 },
  { name: 'Baobab',         query: 'baobab tree africa',        tags: ['baobab', 'atmosphere'],                        destinationType: 'safari',   count: 4 },
];

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const filterArg = args.find(a => a.startsWith('--filter='));
const FILTER = filterArg ? filterArg.split('=')[1].toLowerCase() : null;

// ─── Setup ───────────────────────────────────────────────────────────────────
const PEXELS_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_KEY) {
  console.error('PEXELS_API_KEY not set in .env');
  process.exit(1);
}
if (LIVE && !process.env.CLOUDINARY_CLOUD_NAME) {
  console.error('CLOUDINARY_* env vars required for --live');
  process.exit(1);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function searchPexels(query, perPage) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&page=1`;
  const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
  if (!res.ok) throw new Error(`Pexels ${res.status} for "${query}"`);
  const data = await res.json();
  return data.photos || [];
}

async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function uploadToCloudinary(buffer, destinationType) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `safari-crm/library/seed/${destinationType}`, resource_type: 'image', quality: 'auto', fetch_format: 'auto' },
      (err, result) => err ? reject(err) : resolve(result),
    );
    stream.end(buffer);
  });
}

// Process one photo: skip if already imported, else re-host + create record.
async function processPhoto(photo, bucket) {
  const pexelsPageUrl = photo.url; // https://www.pexels.com/photo/.../
  const existing = await LibraryImage.findOne({ sourceUrl: pexelsPageUrl }).select('_id').lean();
  if (existing) return { status: 'skipped' };

  const srcUrl = photo.src?.large2x || photo.src?.large || photo.src?.original;
  const buffer = await downloadBuffer(srcUrl);
  const uploaded = await uploadToCloudinary(buffer, bucket.destinationType);

  await LibraryImage.create({
    url: uploaded.secure_url,
    publicId: uploaded.public_id,
    caption: photo.alt || '',
    credit: photo.photographer ? `Photo by ${photo.photographer} on Pexels` : 'Pexels',
    attribution: 'Pexels License — free for commercial use',
    sourceUrl: pexelsPageUrl,
    tags: bucket.tags,
    destinationType: bucket.destinationType,
    isActive: true,
  });
  return { status: 'created' };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${LIVE ? '🚀 LIVE MODE' : '🧪 DRY RUN'} — ${FILTER ? `filter="${FILTER}"` : 'all buckets'}\n`);

  const buckets = FILTER ? BUCKETS.filter(b => b.name.toLowerCase().includes(FILTER)) : BUCKETS;
  if (buckets.length === 0) {
    console.error(`No buckets matched filter "${FILTER}"`);
    process.exit(1);
  }

  const plannedTotal = buckets.reduce((sum, b) => sum + b.count, 0);
  console.log(`Plan: ${buckets.length} buckets, up to ${plannedTotal} images total\n`);

  if (!LIVE) {
    buckets.forEach(b => console.log(`  • [${b.destinationType.padEnd(9)}] ${b.name.padEnd(24)} "${b.query}"  ×${b.count}`));
    console.log('\nPass --live to actually upload.\n');
    process.exit(0);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  const counts = { created: 0, skipped: 0, failed: 0 };

  for (const bucket of buckets) {
    process.stdout.write(`[${bucket.name}] searching... `);
    let photos;
    try {
      photos = await searchPexels(bucket.query, bucket.count);
    } catch (e) {
      console.log(`SEARCH FAILED: ${e.message}`);
      counts.failed += bucket.count;
      continue;
    }
    console.log(`${photos.length} photos found`);

    // Process 3 at a time — polite to Pexels + Cloudinary, still fast.
    for (let i = 0; i < photos.length; i += 3) {
      const batch = photos.slice(i, i + 3);
      const results = await Promise.allSettled(batch.map(p => processPhoto(p, bucket)));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          counts[r.value.status]++;
          process.stdout.write(r.value.status === 'created' ? '+' : '·');
        } else {
          counts.failed++;
          process.stdout.write('x');
          console.log(`\n   ✗ photo ${batch[idx].id}: ${r.reason?.message || r.reason}`);
        }
      });
    }
    console.log('');
    await sleep(300); // breathe between buckets
  }

  console.log(`\n✓ Done. Created: ${counts.created}  Skipped: ${counts.skipped}  Failed: ${counts.failed}`);
  await mongoose.disconnect();
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
