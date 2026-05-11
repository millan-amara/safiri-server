// One-off: import deals from an exported CSV into an existing pipeline.
//
// Usage (run from server/):
//   node scripts/importDeals.js --csv=./pipeline-export.csv --user=you@example.com --pipeline="Main Pipeline"
//   node scripts/importDeals.js --csv=./pipeline-export.csv --user=you@example.com --pipeline="Main Pipeline" --live
//
// Defaults to a DRY RUN that prints exactly what would be created. Add --live to write.
//
// What this script does:
//   1. Looks up your organization from --user (your login email).
//   2. Loads the named pipeline and validates every row's stage exists on it.
//      (You said you renamed the new pipeline's stages to match the CSV — this enforces that.)
//   3. For each row, builds a Deal and LINKS to an existing Contact by email or phone.
//      Does NOT create contacts — those should already be imported via the UI flow.
//      Unmatched rows still create a deal (just without contact reference).
//   4. Tags every imported deal with `imported` so you can bulk-remove if something goes sideways.
//
// Before running:
//   - Edit COLUMN_MAP below so each key matches a header from YOUR CSV exactly (case-sensitive).
//     Leave a value as '' if your CSV doesn't have that field.
//   - `title` and `stage` are required. Everything else is optional.

import dotenv from 'dotenv';
import fs from 'fs';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Contact from '../models/Contact.js';
import { Deal, Pipeline } from '../models/Deal.js';

dotenv.config();

// ─── Edit this to match your CSV headers ─────────────────────────────────────
const COLUMN_MAP = {
  title:             'Title',           // required
  stage:             'Stage',           // required — must match a stage name on the target pipeline
  contactEmail:      'Contact email',   // preferred lookup key for linking the existing contact
  contactPhone:      'Contact phone',   // lookup fallback; matched with and without the Excel apostrophe
  value:             'Value',           // numeric; currency symbols and commas are stripped
  currency:          'Currency',        // e.g. USD, KES — defaults to USD if blank
  probability:       'Probability %',   // 0-100; non-numeric becomes 0
  expectedCloseDate: 'Expected close',  // any Date.parse-able string (ISO preferred)
  // Not in your CSV — leave blank. Add headers later if your exports gain them.
  destination:       '',
  groupSize:         '',
  budget:            '',
  leadSource:        '',
  notes:             '',
};

const LEAD_SOURCE_ENUM = new Set(['website', 'referral', 'repeat', 'travel_agent', 'social', 'email', 'phone', 'walk_in', 'other']);
const IMPORT_TAG = 'imported';

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const getArg = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const CSV_PATH = getArg('csv');
const USER_EMAIL = getArg('user');
const ORG_ID_ARG = getArg('org');
const PIPELINE_NAME = getArg('pipeline');

if (!CSV_PATH || !PIPELINE_NAME || (!USER_EMAIL && !ORG_ID_ARG)) {
  console.error('Required: --csv=<path> --pipeline="<pipeline name>" and at least one of --org=<id> or --user=<email>');
  console.error('  --org=<id>      target organization (preferred when known)');
  console.error('  --user=<email>  if given, used as createdBy for imported deals; org inferred from user when --org is omitted');
  process.exit(1);
}
if (!process.env.MONGO_URI && !process.env.MONGODB_URI) {
  console.error('MONGO_URI (or MONGODB_URI) must be set in .env');
  process.exit(1);
}

// ─── RFC4180-ish CSV parser (copied from routes/uploads.js so this script is standalone) ──
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; continue; }
      if (c === '"') { inQuotes = false; continue; }
      cell += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') { continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
  return rows;
}

// ─── Coercion helpers ────────────────────────────────────────────────────────
const parseNumber = (s) => {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const parseDate = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};
// Excel exports phones as `'+254...` to force text format. Strip the lead apostrophe.
const normalizePhone = (s) => (s || '').replace(/^'+/, '').trim();
// Strip unresolved `{{contact.lastName}}`-style template artifacts from titles.
const cleanTitle = (s) => (s || '').replace(/\s*\{\{[^}]+\}\}/g, '').trim();
const parseProbability = (s) => Math.min(100, Math.max(0, parseNumber(s)));

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  console.log(`Connected to MongoDB. Mode: ${LIVE ? 'LIVE (will write)' : 'DRY RUN'}\n`);

  // Resolve org. --org wins if given; otherwise infer from --user's account.
  let user = null;
  if (USER_EMAIL) {
    user = await User.findOne({ email: USER_EMAIL.toLowerCase() }).lean();
    if (!user) { console.error(`No user found for ${USER_EMAIL}`); process.exit(1); }
  }
  const orgId = ORG_ID_ARG
    ? new mongoose.Types.ObjectId(ORG_ID_ARG)
    : user.organization;
  if (user && ORG_ID_ARG && String(user.organization) !== String(orgId)) {
    console.log(`Note: --user (${user.email}) belongs to org ${user.organization}, but --org overrides to ${orgId}.`);
  }
  console.log(`Org: ${orgId}${user ? `  (createdBy: ${user.email})` : '  (createdBy: null — no --user given)'}`);

  // Resolve pipeline + build stage lookup
  const pipeline = await Pipeline.findOne({ organization: orgId, name: PIPELINE_NAME, isActive: true }).lean();
  if (!pipeline) { console.error(`No active pipeline named "${PIPELINE_NAME}" on this org`); process.exit(1); }
  const validStages = new Set(pipeline.stages.map(s => s.name));
  console.log(`Pipeline: ${pipeline.name}  →  stages: ${[...validStages].join(', ')}\n`);

  // Load CSV
  if (!fs.existsSync(CSV_PATH)) { console.error(`CSV not found: ${CSV_PATH}`); process.exit(1); }
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf-8'));
  if (rows.length < 2) { console.error('CSV needs a header row and at least one data row'); process.exit(1); }
  const headers = rows[0].map(h => h.trim());

  // Sanity-check mapping: every non-empty COLUMN_MAP value must exist in headers
  const missingHeaders = Object.entries(COLUMN_MAP)
    .filter(([, h]) => h && !headers.includes(h))
    .map(([k, h]) => `${k} → "${h}"`);
  if (missingHeaders.length) {
    console.error('These COLUMN_MAP entries don\'t match any CSV header — fix or blank them:');
    missingHeaders.forEach(m => console.error(`  ${m}`));
    console.error(`\nYour CSV headers were: ${headers.map(h => `"${h}"`).join(', ')}`);
    process.exit(1);
  }

  const colIdx = Object.fromEntries(
    Object.entries(COLUMN_MAP).map(([k, h]) => [k, h ? headers.indexOf(h) : -1])
  );
  const cell = (vals, key) => (colIdx[key] >= 0 ? (vals[colIdx[key]] ?? '').trim() : '');

  let imported = 0;
  let skipped = 0;
  let contactsNotFound = 0;
  const errors = [];

  for (let i = 1; i < rows.length; i++) {
    const vals = rows[i];
    const rowNum = i + 1;
    try {
      const title = cleanTitle(cell(vals, 'title'));
      const stage = cell(vals, 'stage');
      if (!title)            { skipped++; errors.push(`Row ${rowNum}: missing title — skipped`); continue; }
      if (!stage)            { skipped++; errors.push(`Row ${rowNum}: missing stage — skipped`); continue; }
      if (!validStages.has(stage)) {
        skipped++;
        errors.push(`Row ${rowNum}: stage "${stage}" not on pipeline — skipped`);
        continue;
      }

      // Contact resolution — LINK ONLY (never create). Contacts were imported
      // via the UI separately, so any miss here means the deal lands without a
      // linked contact and you can wire it up manually. Phones are matched in
      // both the raw (`'+254...`, Excel apostrophe baked in by the UI importer)
      // and normalized (`+254...`) forms to be tolerant of either.
      let contactId = null;
      const cEmail = cell(vals, 'contactEmail').toLowerCase();
      const cPhoneRaw = cell(vals, 'contactPhone');
      const cPhone = normalizePhone(cPhoneRaw);
      if (cEmail || cPhone) {
        const query = { organization: orgId };
        if (cEmail) {
          query.email = cEmail;
        } else {
          query.phone = { $in: [cPhone, `'${cPhone}`, cPhoneRaw].filter(Boolean) };
        }
        const contact = await Contact.findOne(query).lean();
        if (contact) {
          contactId = contact._id;
        } else {
          contactsNotFound++;
          errors.push(`Row ${rowNum}: no contact matched ${cEmail || cPhone} — deal will be unlinked`);
        }
      }

      const leadSourceRaw = cell(vals, 'leadSource').toLowerCase().replace(/\s+/g, '_');
      const leadSource = LEAD_SOURCE_ENUM.has(leadSourceRaw) ? leadSourceRaw : (leadSourceRaw ? 'other' : '');

      const deal = {
        organization: orgId,
        title,
        pipeline: pipeline._id,
        stage,
        contact: contactId,
        destination: cell(vals, 'destination'),
        value: parseNumber(cell(vals, 'value')),
        currency: cell(vals, 'currency') || 'USD',
        budget: parseNumber(cell(vals, 'budget')),
        budgetCurrency: cell(vals, 'currency') || 'USD',
        groupSize: parseNumber(cell(vals, 'groupSize')),
        probability: parseProbability(cell(vals, 'probability')),
        expectedCloseDate: parseDate(cell(vals, 'expectedCloseDate')),
        leadSource,
        createdBy: user?._id,
        tags: [IMPORT_TAG],
        activities: [{ type: 'deal_created', description: `Imported from CSV`, createdBy: user?._id }],
      };

      const notes = cell(vals, 'notes');
      if (notes) deal.notes = [{ text: notes, createdBy: user?._id, isPinned: true }];

      // Reflect won/lost based on the pipeline's stage type, like the app does elsewhere
      const stageDef = pipeline.stages.find(s => s.name === stage);
      if (stageDef?.type === 'won')  deal.wonAt = new Date();
      if (stageDef?.type === 'lost') deal.lostAt = new Date();

      if (LIVE) {
        await Deal.create(deal);
      }
      imported++;
      const contactLabel = cEmail || cPhone || '';
      console.log(`  ${LIVE ? '✓' : '·'} Row ${rowNum}: "${title}" → ${stage}${contactLabel ? `  (contact: ${contactLabel})` : ''}`);
    } catch (e) {
      skipped++;
      errors.push(`Row ${rowNum}: ${e.message}`);
    }
  }

  console.log('\n─── Summary ───');
  console.log(`Mode:             ${LIVE ? 'LIVE' : 'DRY RUN (no writes)'}`);
  console.log(`Rows processed:   ${rows.length - 1}`);
  console.log(`Deals ${LIVE ? 'created' : 'would create'}: ${imported}`);
  console.log(`Contacts not matched (deal will be unlinked): ${contactsNotFound}`);
  console.log(`Skipped:          ${skipped}`);
  if (errors.length) {
    console.log('\nIssues:');
    errors.forEach(e => console.log(`  - ${e}`));
  }
  if (!LIVE && imported > 0) console.log('\nRe-run with --live to actually write.');

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('Fatal:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
