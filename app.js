import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import connectDB from './config/db.js';

import authRoutes from './routes/auth.js';
import partnerRoutes from './routes/partners.js';
import crmRoutes from './routes/crm.js';
import quoteRoutes from './routes/quotes.js';
import settingsRoutes from './routes/settings.js';
import aiRoutes from './routes/ai.js';
import uploadRoutes from './routes/uploads.js';
import pdfRoutes from './routes/pdf.js';
import notificationRoutes from './routes/notifications.js';
import destinationRoutes from './routes/destinations.js';
import automationRoutes from './routes/automations.js';
import webhookRoutes from './routes/webhooks.js';
import cronRoutes from './routes/cron.js';
import billingRoutes from './routes/billing.js';
import libraryRoutes from './routes/library.js';
import onboardingRoutes from './routes/onboarding.js';
import scheduledMessagesRoutes from './routes/scheduledMessages.js';
import savedViewsRoutes from './routes/savedViews.js';
import invoicesRoutes from './routes/invoices.js';
import vouchersRoutes from './routes/vouchers.js';
import messagesRoutes from './routes/messages.js';
import webhookDeliveriesRoutes from './routes/webhookDeliveries.js';
import adminRoutes from './routes/admin.js';
import { checkInactiveDeals, checkOverdueTasks } from './automations/engine.js';
import { startReminderPoller } from './queues/reminderPoller.js';
import { startScheduledMessagePoller } from './queues/scheduledMessagePoller.js';
import { startWebhookRetryPoller } from './queues/webhookRetryPoller.js';

dotenv.config();

const app = express();

// Behind Render/Netlify the request hits a load balancer first; without
// trust-proxy `req.ip` is always the LB's IP, which makes per-IP rate
// limiting and the share-link viewLog useless. `1` means "trust the first
// hop" (Render terminates TLS one hop in front of us); bump higher only if
// you stack additional proxies.
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
}));

// ── Paystack webhook: capture raw body BEFORE express.json() ─────────────────
// Paystack signature verification requires the raw request body string.
// express.raw() reads the body as a Buffer; we convert it and re-attach as req.body
// so the billing route handler receives a normal parsed object. Cap at 1mb —
// Paystack payloads are kilobytes; anything bigger is abuse.
app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body.toString('utf8');
    try { req.body = JSON.parse(req.rawBody); } catch { req.body = {}; }
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
// 'dev' is colorized and concise (good for local); 'combined' is the standard
// Apache-style log production aggregators expect. Test env stays silent.
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── Rate limiters ───────────────────────────────────────────────────────────
// Slow down brute-force / credential-stuffing on auth endpoints, and abuse of
// the unauthenticated public quote-share endpoints. Applied per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 30,                   // 30 auth requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down and try again in a few minutes.' },
  skip: () => process.env.NODE_ENV === 'test',
});

const publicQuoteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,             // 60 share requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down.' },
  skip: () => process.env.NODE_ENV === 'test',
});

// Mount the public-quote limiter on the share path before the main quotes
// router so unauthenticated traffic (the only thing that hits /share/*) is
// always rate-limited regardless of router order.
app.use('/api/quotes/share', publicQuoteLimiter);

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/partners', partnerRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/quotes', quoteRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/pdf', pdfRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/destinations', destinationRoutes);
app.use('/api/automations', automationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/scheduled-messages', scheduledMessagesRoutes);
app.use('/api/saved-views', savedViewsRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/vouchers', vouchersRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/webhook-deliveries', webhookDeliveriesRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// Error handler — backstop for routes that don't catch their own errors.
// Most routes already handle errors with explicit try/catch and return their
// own message; this catches Express/middleware throws (multer mimetype
// rejections, JSON parse errors, etc.).
//
// In production we don't echo arbitrary err.message to clients for 5xx —
// Mongo/network errors can leak DB names, hostnames, query shapes. Client-
// triggered 4xx errors (status set by the thrower) keep their message so
// validation feedback still works.
app.use((err, req, res, next) => {
  console.error(err.stack || err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && process.env.NODE_ENV === 'production') {
    return res.status(status).json({ message: 'Server error' });
  }
  res.status(status).json({ message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();

  // Clean up stale indexes that may cause issues
  try {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;

    // Fix quote indexes
    const quoteColls = await db.listCollections({ name: 'quotes' }).toArray();
    if (quoteColls.length > 0) {
      const indexes = await db.collection('quotes').indexes();
      for (const idx of indexes) {
        if (idx.name !== '_id_' && idx.key?.shareToken === 1 && idx.name !== 'shareToken_1') {
          await db.collection('quotes').dropIndex(idx.name);
          console.log(`Dropped stale index: ${idx.name}`);
        }
        // Legacy global unique index on quoteNumber — replaced by a per-org compound index.
        // Without this drop, two different orgs can't have the same quoteNumber (e.g. "2026-0001").
        if (idx.name === 'quoteNumber_1') {
          await db.collection('quotes').dropIndex(idx.name);
          console.log('Dropped legacy global quoteNumber_1 index (now per-org)');
        }
      }
    }

    // Remove destinations without organization (leftover from old global schema)
    const destColls = await db.listCollections({ name: 'destinations' }).toArray();
    if (destColls.length > 0) {
      const result = await db.collection('destinations').deleteMany({ organization: { $exists: false } });
      if (result.deletedCount > 0) console.log(`Cleaned ${result.deletedCount} org-less destinations`);

      // Drop old text index if it exists (replaced with org+name compound)
      try {
        const destIndexes = await db.collection('destinations').indexes();
        for (const idx of destIndexes) {
          if (idx.name !== '_id_' && (idx.key?.name === 'text' || idx.key?._fts === 'text')) {
            await db.collection('destinations').dropIndex(idx.name);
            console.log(`Dropped stale destination index: ${idx.name}`);
          }
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) {
    // Not critical
  }

  // ── CRM access-control backfill (idempotent) ─────────────────────────────────
  // Adds visibility/members defaults to existing pipelines and preferences
  // defaults to existing organizations. Safe to run on every boot.
  try {
    const Org = (await import('./models/Organization.js')).default;
    const { Pipeline } = await import('./models/Deal.js');

    const pipResult = await Pipeline.updateMany(
      { visibility: { $exists: false } },
      { $set: { visibility: 'organization', members: [] } }
    );
    if (pipResult.modifiedCount > 0) {
      console.log(`Backfilled access fields on ${pipResult.modifiedCount} pipelines`);
    }

    const orgResult = await Org.updateMany(
      { 'preferences.dealHandoffMode': { $exists: false } },
      { $set: { 'preferences.dealHandoffMode': 'convert', 'preferences.agentDealDeletion': 'own' } }
    );
    if (orgResult.modifiedCount > 0) {
      console.log(`Backfilled preferences on ${orgResult.modifiedCount} organizations`);
    }

    const reassignResult = await Org.updateMany(
      { 'preferences.agentDealReassign': { $exists: false } },
      { $set: { 'preferences.agentDealReassign': 'own' } }
    );
    if (reassignResult.modifiedCount > 0) {
      console.log(`Backfilled agentDealReassign on ${reassignResult.modifiedCount} organizations`);
    }

    const sendTimeResult = await Org.updateMany(
      { 'preferences.scheduledMessageHour': { $exists: false } },
      { $set: {
        'preferences.scheduledMessageHour': 9,
        'preferences.scheduledMessageTimezone': 'Africa/Nairobi',
      } }
    );
    if (sendTimeResult.modifiedCount > 0) {
      console.log(`Backfilled scheduledMessage time defaults on ${sendTimeResult.modifiedCount} organizations`);
    }

    const invoicePrefsResult = await Org.updateMany(
      { 'preferences.autoGenerateInvoiceOnWon': { $exists: false } },
      { $set: {
        'preferences.autoGenerateInvoiceOnWon': true,
        'preferences.defaultTaxPercent': 0,
        'preferences.paymentInstructions': '',
      } }
    );
    if (invoicePrefsResult.modifiedCount > 0) {
      console.log(`Backfilled invoice preferences on ${invoicePrefsResult.modifiedCount} organizations`);
    }

    const depositPrefsResult = await Org.updateMany(
      { 'preferences.depositPercent': { $exists: false } },
      { $set: {
        'preferences.depositPercent': 30,
        'preferences.depositDueDays': 7,
        'preferences.balanceDaysBeforeTravel': 60,
      } }
    );
    if (depositPrefsResult.modifiedCount > 0) {
      console.log(`Backfilled deposit/balance preferences on ${depositPrefsResult.modifiedCount} organizations`);
    }

    const webhookPrefsResult = await Org.updateMany(
      { 'preferences.accountingWebhookUrl': { $exists: false } },
      { $set: {
        'preferences.accountingWebhookUrl': '',
        'preferences.accountingWebhookSecret': '',
      } }
    );
    if (webhookPrefsResult.modifiedCount > 0) {
      console.log(`Backfilled accounting webhook prefs on ${webhookPrefsResult.modifiedCount} organizations`);
    }

    // Backfill stage.type — assign 'won'/'lost' to known terminal names so
    // existing pipelines work with type-based won/lost detection.
    // Recognized: Won, Closed Won, Booked → won; Lost, Closed Lost, Disqualified → lost;
    // Handed to Sales → won (Marketing pipeline pattern).
    const wonNames = ['Won', 'Closed Won', 'Booked', 'Handed to Sales'];
    const lostNames = ['Lost', 'Closed Lost', 'Disqualified'];

    const allPipelines = await Pipeline.find({}).select('stages').lean();
    let stageBackfillCount = 0;
    for (const p of allPipelines) {
      const stages = p.stages || [];
      let dirty = false;
      const updated = stages.map(s => {
        if (s.type) return s;
        dirty = true;
        let type = 'open';
        if (wonNames.includes(s.name)) type = 'won';
        else if (lostNames.includes(s.name)) type = 'lost';
        return { ...s, type };
      });
      if (dirty) {
        await Pipeline.updateOne({ _id: p._id }, { $set: { stages: updated } });
        stageBackfillCount++;
      }
    }
    if (stageBackfillCount > 0) {
      console.log(`Backfilled stage.type on ${stageBackfillCount} pipelines`);
    }

    // ── Credit-weight rebase (idempotent) ────────────────────────────────────
    // Chunk 2 of the billing rework re-weighted AI credits (heavy 10→50,
    // medium 3→5) and raised every plan's monthly allowance proportionally.
    // For any existing org whose stored aiCreditsLimit is below the current
    // plan's allowance, raise it now so they get the new headroom immediately
    // instead of waiting for the next calendar-month reset. We never lower a
    // limit (an enterprise org with a custom higher cap should keep it).
    const { PLANS, nextMonthlyResetDate } = await import('./config/plans.js');
    let creditLimitBumped = 0;
    for (const [planKey, planConfig] of Object.entries(PLANS)) {
      const result = await Org.updateMany(
        { plan: planKey, aiCreditsLimit: { $lt: planConfig.aiCredits } },
        { $set: { aiCreditsLimit: planConfig.aiCredits } }
      );
      creditLimitBumped += result.modifiedCount;
    }
    if (creditLimitBumped > 0) {
      console.log(`Raised aiCreditsLimit to current plan allowance on ${creditLimitBumped} organizations`);
    }

    // ── PDF page metering seed (Chunk 4, idempotent) ─────────────────────────
    // Backfill pdfPagesLimit + pdfPagesResetAt for orgs that existed before
    // the field was introduced. Only sets when missing — never overrides a
    // limit an admin (or this same backfill on a later boot) already set.
    const pdfNextReset = nextMonthlyResetDate();
    let pdfSeeded = 0;
    for (const [planKey, planConfig] of Object.entries(PLANS)) {
      if (planConfig.pdfPagesPerMonth == null) continue;
      const result = await Org.updateMany(
        { plan: planKey, pdfPagesLimit: { $exists: false } },
        { $set: { pdfPagesLimit: planConfig.pdfPagesPerMonth } }
      );
      pdfSeeded += result.modifiedCount;
    }
    const pdfResetSeeded = await Org.updateMany(
      { pdfPagesResetAt: { $exists: false } },
      { $set: { pdfPagesResetAt: pdfNextReset } }
    );
    if (pdfSeeded > 0 || pdfResetSeeded.modifiedCount > 0) {
      console.log(`Seeded pdfPagesLimit on ${pdfSeeded} orgs + pdfPagesResetAt on ${pdfResetSeeded.modifiedCount} orgs`);
    }

    // Backfill TTL expireAt on already-terminal webhook deliveries so they
    // age out via the new TTL index instead of accumulating indefinitely.
    const WebhookDelivery = (await import('./models/WebhookDelivery.js')).default;
    const succExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const failExpiry = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    const succBackfill = await WebhookDelivery.updateMany(
      { status: 'succeeded', expireAt: { $in: [null, undefined] } },
      { $set: { expireAt: succExpiry } }
    );
    const failBackfill = await WebhookDelivery.updateMany(
      { status: 'failed', expireAt: { $in: [null, undefined] } },
      { $set: { expireAt: failExpiry } }
    );
    if (succBackfill.modifiedCount + failBackfill.modifiedCount > 0) {
      console.log(`Backfilled TTL expireAt on ${succBackfill.modifiedCount} succeeded + ${failBackfill.modifiedCount} failed deliveries`);
    }
  } catch (e) {
    console.error('CRM access backfill failed:', e.message);
  }


  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // Run scheduled automation checks
    setInterval(checkInactiveDeals, 6 * 60 * 60 * 1000);  // every 6 hours
    setInterval(checkOverdueTasks, 60 * 60 * 1000);        // every hour

    // Task reminder poller — MongoDB-backed, 60s interval
    startReminderPoller();

    // Scheduled-message poller — pre-trip / lifecycle messages, 60s interval
    startScheduledMessagePoller();

    // Webhook retry poller — re-attempts pending invoice webhooks per backoff
    startWebhookRetryPoller();
  });
};

start();