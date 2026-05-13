import { Router } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import Organization from '../models/Organization.js';
import User from '../models/User.js';
import AiUsageLog from '../models/AiUsageLog.js';
import SearchLog from '../models/SearchLog.js';
import Quote from '../models/Quote.js';
import { Deal } from '../models/Deal.js';
import Invoice from '../models/Invoice.js';
import { protect, requireSuperAdmin } from '../middleware/auth.js';
import * as paystack from '../services/paystack.js';
import { PLANS } from '../config/plans.js';
import { sendEmail, inviteEmail } from '../utils/email.js';

const router = Router();

// Every endpoint below is gated by the SUPERADMIN_EMAILS env allowlist.
// Cross-tenant data — never expose to regular org users.
router.use(protect, requireSuperAdmin);

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const num = (arr, key = 'n') => (arr?.[0]?.[key] ?? 0);
const groupToObj = (arr) =>
  Object.fromEntries((arr || []).map((r) => [r._id ?? 'unknown', r.count]));

// ─── GET /api/admin/stats ───────────────────────────────────────────────────
// Top-level KPI snapshot for the dashboard hero row: org/plan/status counts,
// signups, recent activity, 30-day AI spend + cache hit ratio.
router.get('/stats', async (req, res) => {
  try {
    const ago7 = daysAgo(7);
    const ago30 = daysAgo(30);

    const [orgFacet, userFacet, quoteFacet, dealFacet, aiAgg] = await Promise.all([
      Organization.aggregate([{ $facet: {
        total: [{ $count: 'n' }],
        byStatus: [{ $group: { _id: '$subscriptionStatus', count: { $sum: 1 } } }],
        byPlan: [{ $group: { _id: '$plan', count: { $sum: 1 } } }],
        signups7d: [{ $match: { createdAt: { $gte: ago7 } } }, { $count: 'n' }],
        signups30d: [{ $match: { createdAt: { $gte: ago30 } } }, { $count: 'n' }],
      } }]),
      User.aggregate([{ $facet: {
        total: [{ $count: 'n' }],
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        activeRecent: [{ $match: { lastLogin: { $gte: ago30 } } }, { $count: 'n' }],
      } }]),
      Quote.aggregate([{ $facet: {
        total: [{ $count: 'n' }],
        last7d: [{ $match: { createdAt: { $gte: ago7 } } }, { $count: 'n' }],
        last30d: [{ $match: { createdAt: { $gte: ago30 } } }, { $count: 'n' }],
      } }]),
      Deal.aggregate([{ $facet: {
        total: [{ $count: 'n' }],
        last30d: [{ $match: { createdAt: { $gte: ago30 } } }, { $count: 'n' }],
      } }]),
      AiUsageLog.aggregate([
        { $match: { timestamp: { $gte: ago30 } } },
        { $group: {
          _id: null,
          totalCost: { $sum: '$estimatedCostUsd' },
          calls: { $sum: 1 },
          successes: { $sum: { $cond: ['$success', 1, 0] } },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          cacheReadTokens: { $sum: '$cacheReadInputTokens' },
          cacheCreateTokens: { $sum: '$cacheCreationInputTokens' },
        } },
      ]),
    ]);

    const orgF = orgFacet[0] || {};
    const userF = userFacet[0] || {};
    const quoteF = quoteFacet[0] || {};
    const dealF = dealFacet[0] || {};
    const ai = aiAgg[0] || {};

    // Cache-hit ratio = cached input tokens / all input tokens seen by the model
    // (cached + fresh + cache-creation). cache-creation tokens are billed once
    // and saved many times, so we count them in the denominator.
    const totalInputUnits =
      (ai.inputTokens || 0) + (ai.cacheCreateTokens || 0) + (ai.cacheReadTokens || 0);
    const cacheHitRatio = totalInputUnits > 0
      ? (ai.cacheReadTokens || 0) / totalInputUnits
      : 0;

    res.json({
      orgs: {
        total: num(orgF.total),
        byStatus: groupToObj(orgF.byStatus),
        byPlan: groupToObj(orgF.byPlan),
        signups7d: num(orgF.signups7d),
        signups30d: num(orgF.signups30d),
      },
      users: {
        total: num(userF.total),
        byStatus: groupToObj(userF.byStatus),
        activeRecent: num(userF.activeRecent),
      },
      quotes: {
        total: num(quoteF.total),
        last7d: num(quoteF.last7d),
        last30d: num(quoteF.last30d),
      },
      deals: {
        total: num(dealF.total),
        last30d: num(dealF.last30d),
      },
      ai30d: {
        totalCostUsd: ai.totalCost || 0,
        calls: ai.calls || 0,
        successRate: ai.calls > 0 ? (ai.successes || 0) / ai.calls : 1,
        inputTokens: ai.inputTokens || 0,
        outputTokens: ai.outputTokens || 0,
        cacheReadTokens: ai.cacheReadTokens || 0,
        cacheCreateTokens: ai.cacheCreateTokens || 0,
        cacheHitRatio,
      },
      generatedAt: new Date(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/ai-usage ────────────────────────────────────────────────
// Daily cost series + per-endpoint breakdown + top 10 orgs by spend. ?days=
// caps at 90 to keep the aggregation cheap; default is 30.
router.get('/ai-usage', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const since = daysAgo(days);

    const [daily, byEndpoint, topOrgs] = await Promise.all([
      AiUsageLog.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          cost: { $sum: '$estimatedCostUsd' },
          calls: { $sum: 1 },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          cacheReadTokens: { $sum: '$cacheReadInputTokens' },
        } },
        { $sort: { _id: 1 } },
      ]),
      AiUsageLog.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $group: {
          _id: '$endpoint',
          calls: { $sum: 1 },
          successes: { $sum: { $cond: ['$success', 1, 0] } },
          cost: { $sum: '$estimatedCostUsd' },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          cacheReadTokens: { $sum: '$cacheReadInputTokens' },
        } },
        { $sort: { cost: -1 } },
      ]),
      AiUsageLog.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $group: { _id: '$organizationId', cost: { $sum: '$estimatedCostUsd' }, calls: { $sum: 1 } } },
        { $sort: { cost: -1 } },
        { $limit: 10 },
        { $lookup: {
          from: Organization.collection.collectionName,
          localField: '_id',
          foreignField: '_id',
          as: 'org',
          pipeline: [{ $project: { name: 1, plan: 1, subscriptionStatus: 1 } }],
        } },
        { $project: {
          _id: 0,
          organizationId: '$_id',
          cost: 1,
          calls: 1,
          name: { $ifNull: [{ $arrayElemAt: ['$org.name', 0] }, '(deleted org)'] },
          plan: { $arrayElemAt: ['$org.plan', 0] },
          subscriptionStatus: { $arrayElemAt: ['$org.subscriptionStatus', 0] },
        } },
      ]),
    ]);

    // Zero-fill missing days so a Recharts line draws a continuous axis
    // even when there were no AI calls on a given day.
    const dailyMap = new Map(daily.map((d) => [d._id, d]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      const row = dailyMap.get(key);
      series.push({
        date: key,
        cost: row?.cost || 0,
        calls: row?.calls || 0,
        inputTokens: row?.inputTokens || 0,
        outputTokens: row?.outputTokens || 0,
        cacheReadTokens: row?.cacheReadTokens || 0,
      });
    }

    res.json({
      windowDays: days,
      series,
      byEndpoint: byEndpoint.map((r) => ({
        endpoint: r._id,
        calls: r.calls,
        successRate: r.calls > 0 ? r.successes / r.calls : 1,
        cost: r.cost,
        avgCost: r.calls > 0 ? r.cost / r.calls : 0,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
      })),
      topOrgs,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/orgs ────────────────────────────────────────────────────
// Paginated org list with owner email + member count for the dashboard table.
// Filters: ?status= ?plan= ?q= (name regex). Sort: ?sort=createdAt&dir=desc.
router.get('/orgs', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.subscriptionStatus = req.query.status;
    if (req.query.plan) filter.plan = req.query.plan;

    // ?q= matches against org name, owner email, owner phone, and the org's
    // businessInfo.phone. Phone matching is normalised so all of these find
    // the same Kenya mobile:
    //   "0734567890"     (local leading-0 format)
    //   "+254734567890"  (E.164)
    //   "254 734 567 890" (mixed-format)
    //   "734567890"      (raw subscriber digits)
    // Strategy: take the digits of the query; build candidate substrings that
    // strip the leading 0 or 254 country code; OR-match every candidate against
    // both User.phone and businessInfo.phone. Owner-email is matched via a
    // pre-lookup of User → orgIds so we can keep the $match before the
    // expensive $lookups in the aggregate.
    if (req.query.q) {
      const q = req.query.q.trim();
      const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const or = [{ name: { $regex: escapedQ, $options: 'i' } }];

      const digits = q.replace(/[^0-9]/g, '');
      const phoneCandidates = new Set();
      if (digits.length >= 4) {
        phoneCandidates.add(digits);
        if (digits.startsWith('0') && digits.length > 4) phoneCandidates.add(digits.slice(1));
        if (digits.startsWith('254') && digits.length > 6) phoneCandidates.add(digits.slice(3));
      }

      // Pre-lookup: find any user whose email or phone matches. Their org IDs
      // expand the org filter via _id: $in. This costs one extra query but
      // keeps the orgs aggregate from having to scan-then-filter across the
      // full collection.
      const userOr = [{ email: { $regex: escapedQ, $options: 'i' } }];
      for (const p of phoneCandidates) {
        userOr.push({ phone: { $regex: p, $options: 'i' } });
      }
      const matchingUsers = await User.find({ $or: userOr }).select('organization').lean();
      const userOrgIds = [...new Set(matchingUsers.map((u) => String(u.organization)))]
        .map((id) => new mongoose.Types.ObjectId(id));
      if (userOrgIds.length) or.push({ _id: { $in: userOrgIds } });

      // Also match the org's own businessInfo.phone (separate from owner).
      for (const p of phoneCandidates) {
        or.push({ 'businessInfo.phone': { $regex: p, $options: 'i' } });
      }

      filter.$or = or;
    }

    // Allowlist sortable fields — anything else falls back to createdAt to
    // avoid arbitrary-field sorts hitting unindexed columns. lastActiveAt is
    // intentionally absent here — it's computed post-aggregate, so sorting on
    // it would require ordering after $project. The frontend sorts that
    // column client-side on the current page instead.
    const SORTABLE = new Set([
      'createdAt', 'name', 'plan', 'subscriptionStatus',
      'aiCreditsUsed', 'trialEndsAt', 'currentPeriodEnd',
    ]);
    const sortField = SORTABLE.has(req.query.sort) ? req.query.sort : 'createdAt';
    const sortDir = req.query.dir === 'asc' ? 1 : -1;

    const [items, total] = await Promise.all([
      Organization.aggregate([
        { $match: filter },
        { $sort: { [sortField]: sortDir, _id: 1 } },
        { $skip: skip },
        { $limit: limit },
        { $lookup: {
          from: User.collection.collectionName,
          localField: 'owner',
          foreignField: '_id',
          as: 'ownerUser',
          pipeline: [{ $project: { email: 1, name: 1, phone: 1, lastLogin: 1 } }],
        } },
        { $lookup: {
          from: User.collection.collectionName,
          let: { orgId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$organization', '$$orgId'] } } },
            { $group: {
              _id: null,
              count: { $sum: 1 },
              lastLogin: { $max: '$lastLogin' },
            } },
          ],
          as: 'userAgg',
        } },
        // Compute lastActiveAt by aggregating the latest event across the four
        // signal sources that actually indicate "someone used the app". All
        // four collections are indexed by `organization` so per-row cost is
        // bounded — and the orgs list is paginated, capping fan-out.
        { $lookup: {
          from: AiUsageLog.collection.collectionName,
          let: { orgId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$organizationId', '$$orgId'] } } },
            { $sort: { timestamp: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, ts: '$timestamp' } },
          ],
          as: 'lastAi',
        } },
        { $lookup: {
          from: Quote.collection.collectionName,
          let: { orgId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$organization', '$$orgId'] } } },
            { $sort: { updatedAt: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, ts: '$updatedAt' } },
          ],
          as: 'lastQuote',
        } },
        { $lookup: {
          from: Deal.collection.collectionName,
          let: { orgId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$organization', '$$orgId'] } } },
            { $sort: { updatedAt: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, ts: '$updatedAt' } },
          ],
          as: 'lastDeal',
        } },
        { $project: {
          name: 1,
          slug: 1,
          plan: 1,
          annual: 1,
          subscriptionStatus: 1,
          trialStartedAt: 1,
          trialEndsAt: 1,
          currentPeriodEnd: 1,
          aiCreditsUsed: 1,
          aiCreditsLimit: 1,
          purchasedCredits: 1,
          pdfPagesUsed: 1,
          pdfPagesLimit: 1,
          purchasedPdfPages: 1,
          quotesThisMonth: 1,
          whiteLabel: 1,
          'businessInfo.phone': 1,
          'businessInfo.country': 1,
          createdAt: 1,
          owner: { $arrayElemAt: ['$ownerUser', 0] },
          userCount: { $ifNull: [{ $arrayElemAt: ['$userAgg.count', 0] }, 0] },
          lastActiveAt: { $max: [
            { $arrayElemAt: ['$userAgg.lastLogin', 0] },
            { $arrayElemAt: ['$lastAi.ts', 0] },
            { $arrayElemAt: ['$lastQuote.ts', 0] },
            { $arrayElemAt: ['$lastDeal.ts', 0] },
          ] },
        } },
      ]),
      Organization.countDocuments(filter),
    ]);

    res.json({ items, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/orgs/:id ────────────────────────────────────────────────
// Single-org drill-down: full doc + members + counts + recent AI calls +
// invoice totals + webhook delivery health.
router.get('/orgs/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid org id' });
    }
    const org = await Organization.findById(req.params.id).lean();
    if (!org) return res.status(404).json({ message: 'Org not found' });

    const [members, quoteCount, dealCount, dealStats, recentAi, invoiceAgg, recentFailedWebhooks] = await Promise.all([
      User.find({ organization: org._id })
        .select('-password -resetToken -verifyToken -inviteToken')
        .sort({ lastLogin: -1, createdAt: -1 })
        .lean(),
      Quote.countDocuments({ organization: org._id }),
      Deal.countDocuments({ organization: org._id }),
      Deal.aggregate([
        { $match: { organization: org._id } },
        { $group: {
          _id: null,
          openPipelineValue: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$wonAt', null] }, { $eq: ['$lostAt', null] }] },
                { $ifNull: ['$value', 0] },
                0,
              ],
            },
          },
          wonCount: { $sum: { $cond: [{ $ne: ['$wonAt', null] }, 1, 0] } },
          wonValue: { $sum: { $cond: [{ $ne: ['$wonAt', null] }, { $ifNull: ['$value', 0] }, 0] } },
        } },
      ]),
      AiUsageLog.find({ organizationId: org._id })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean(),
      // Invoice rollup: totals invoiced + total paid + outstanding (sent +
      // partially_paid only — draft/cancelled don't count toward AR).
      Invoice.aggregate([
        { $match: { organization: org._id } },
        { $project: {
          status: 1,
          total: 1,
          paidSum: { $sum: '$payments.amount' },
        } },
        { $group: {
          _id: null,
          totalInvoiced: { $sum: '$total' },
          totalPaid: { $sum: '$paidSum' },
          outstanding: {
            $sum: {
              $cond: [
                { $in: ['$status', ['sent', 'partially_paid']] },
                { $subtract: ['$total', '$paidSum'] },
                0,
              ],
            },
          },
          count: { $sum: 1 },
        } },
      ]),
      // Last 10 webhook deliveries that ultimately failed — these are usually
      // the ones support tickets get filed about. Lazy import so admin.js
      // doesn't crash if the model file is renamed.
      (async () => {
        const { default: WebhookDelivery } = await import('../models/WebhookDelivery.js');
        return WebhookDelivery.find({
          organization: org._id,
          status: 'failed',
        })
          .sort({ createdAt: -1 })
          .limit(10)
          .select('event url status attempts lastResponseStatus lastError createdAt deliveredAt')
          .lean();
      })(),
    ]);

    const dealsSummary = dealStats[0] || { openPipelineValue: 0, wonCount: 0, wonValue: 0 };
    const invoices = invoiceAgg[0] || { totalInvoiced: 0, totalPaid: 0, outstanding: 0, count: 0 };

    res.json({
      org,
      members,
      quoteCount,
      dealCount,
      deals: dealsSummary,
      invoices,
      recentAi,
      recentFailedWebhooks,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/orgs/:id/activity ───────────────────────────────────────
// Returns a daily-bucket sparkline and a merged event timeline for the org.
// ?days=30 (default), capped at 90.
router.get('/orgs/:id/activity', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid org id' });
    }
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const since = daysAgo(days);
    const orgId = new mongoose.Types.ObjectId(req.params.id);

    // One $facet pipeline pulls everything we need. Each branch projects a
    // common shape `{ kind, ts, label, refId, refModel, by, meta }` so the
    // frontend can render them all with a single component.
    const [quotes, dealEvents, invoiceEvents, paymentEvents, loginEvents] = await Promise.all([
      Quote.aggregate([
        { $match: { organization: orgId, createdAt: { $gte: since } } },
        { $sort: { createdAt: -1 } },
        { $limit: 30 },
        { $lookup: {
          from: User.collection.collectionName,
          localField: 'createdBy',
          foreignField: '_id',
          as: 'by',
          pipeline: [{ $project: { email: 1, name: 1 } }],
        } },
        { $project: {
          _id: 0,
          kind: { $literal: 'quote_created' },
          ts: '$createdAt',
          label: { $concat: ['Quote ', { $ifNull: ['$quoteNumber', { $toString: '$_id' }] }] },
          refId: '$_id',
          refModel: { $literal: 'Quote' },
          by: { $arrayElemAt: ['$by', 0] },
        } },
      ]),
      // Deals fan into multiple event kinds based on wonAt/lostAt vs. createdAt.
      Deal.aggregate([
        { $match: {
          organization: orgId,
          $or: [
            { createdAt: { $gte: since } },
            { wonAt: { $gte: since } },
            { lostAt: { $gte: since } },
          ],
        } },
        { $lookup: {
          from: User.collection.collectionName,
          localField: 'createdBy',
          foreignField: '_id',
          as: 'by',
          pipeline: [{ $project: { email: 1, name: 1 } }],
        } },
        { $project: {
          _id: 1, title: 1, value: 1, currency: 1, wonAt: 1, lostAt: 1, createdAt: 1,
          by: { $arrayElemAt: ['$by', 0] },
        } },
      ]),
      Invoice.aggregate([
        { $match: { organization: orgId, createdAt: { $gte: since } } },
        { $sort: { createdAt: -1 } },
        { $limit: 30 },
        { $project: {
          _id: 1, invoiceNumber: 1, total: 1, currency: 1, status: 1, createdAt: 1,
        } },
      ]),
      // Payment rows are nested in Invoice.payments. Unwind, filter to the
      // window, sort, slice.
      Invoice.aggregate([
        { $match: { organization: orgId } },
        { $unwind: '$payments' },
        { $match: { 'payments.paidAt': { $gte: since } } },
        { $sort: { 'payments.paidAt': -1 } },
        { $limit: 30 },
        { $project: {
          _id: 0,
          kind: { $literal: 'payment_recorded' },
          ts: '$payments.paidAt',
          label: {
            $concat: [
              'Payment $', { $toString: { $round: ['$payments.amount', 2] } },
              ' on INV-', { $toString: '$invoiceNumber' },
            ],
          },
          refId: '$_id',
          refModel: { $literal: 'Invoice' },
          meta: {
            amount: '$payments.amount',
            currency: '$payments.currency',
            method: '$payments.method',
            source: '$payments.source',
          },
        } },
      ]),
      // Last-login is a single field per user; we report the latest 10 across
      // the org as "login" events. lastLogin is updated on every auth, so
      // duplicate noise is bounded by how many users the org actually has.
      User.aggregate([
        { $match: { organization: orgId, lastLogin: { $gte: since } } },
        { $sort: { lastLogin: -1 } },
        { $limit: 10 },
        { $project: {
          _id: 0,
          kind: { $literal: 'user_login' },
          ts: '$lastLogin',
          label: { $concat: ['Login by ', { $ifNull: ['$email', '(no email)'] }] },
          refId: '$_id',
          refModel: { $literal: 'User' },
          by: { email: '$email', name: '$name' },
        } },
      ]),
    ]);

    // Materialise deal events into one entry per state-change we care about.
    const dealTimeline = [];
    for (const d of dealEvents) {
      const baseLabel = `Deal: ${d.title}`;
      const ccy = d.currency || 'USD';
      const valueStr = d.value ? ` (${ccy} ${d.value.toLocaleString()})` : '';
      if (d.wonAt && d.wonAt >= since) {
        dealTimeline.push({ kind: 'deal_won', ts: d.wonAt, label: `${baseLabel} — won${valueStr}`, refId: d._id, refModel: 'Deal', by: d.by });
      }
      if (d.lostAt && d.lostAt >= since) {
        dealTimeline.push({ kind: 'deal_lost', ts: d.lostAt, label: `${baseLabel} — lost`, refId: d._id, refModel: 'Deal', by: d.by });
      }
      if (d.createdAt && d.createdAt >= since && (!d.wonAt || d.wonAt < since) && (!d.lostAt || d.lostAt < since)) {
        dealTimeline.push({ kind: 'deal_created', ts: d.createdAt, label: `${baseLabel} — created`, refId: d._id, refModel: 'Deal', by: d.by });
      }
    }

    // Invoices likewise: createdAt always; paidAt only if within window.
    const invoiceTimeline = [];
    for (const inv of invoiceEvents) {
      invoiceTimeline.push({
        kind: 'invoice_created',
        ts: inv.createdAt,
        label: `Invoice INV-${inv.invoiceNumber} created (${inv.currency || 'USD'} ${(inv.total || 0).toLocaleString()})`,
        refId: inv._id,
        refModel: 'Invoice',
      });
    }

    // Merge → sort desc → cap at 80 entries.
    const timeline = [
      ...quotes,
      ...dealTimeline,
      ...invoiceTimeline,
      ...paymentEvents,
      ...loginEvents,
    ]
      .filter((e) => e.ts)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 80);

    // Sparkline: daily bucket counts. We only count "creation" events (quotes,
    // deals created, invoices created, payments) — login pings would dwarf
    // everything else and dilute the signal.
    const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
    const bucket = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
      bucket.set(d.toISOString().slice(0, 10), { date: d.toISOString().slice(0, 10), quotes: 0, deals: 0, invoices: 0, payments: 0 });
    }
    const bump = (k, ts) => {
      const key = dayKey(ts);
      const row = bucket.get(key);
      if (row) row[k]++;
    };
    quotes.forEach((q) => bump('quotes', q.ts));
    dealTimeline.forEach((d) => bump('deals', d.ts));
    invoiceTimeline.forEach((i) => bump('invoices', i.ts));
    paymentEvents.forEach((p) => bump('payments', p.ts));
    const sparkline = [...bucket.values()].map((r) => ({
      ...r,
      total: r.quotes + r.deals + r.invoices + r.payments,
    }));

    const lastActiveAt = timeline[0]?.ts || null;

    res.json({ windowDays: days, lastActiveAt, sparkline, timeline });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/users ───────────────────────────────────────────────────
// Search users by email/name across all orgs. Used by the "find a user"
// support-flow widget on the admin page so we don't have to bounce to Atlas.
router.get('/users', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q || q.length < 2) {
      return res.json({ items: [] });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    // Phone-aware search: same normalisation as /admin/orgs. If q has 4+
    // digits, also match User.phone against the digit-stripped query plus
    // variants without the leading 0 / 254 country code.
    const digits = q.replace(/[^0-9]/g, '');
    const orClauses = [{ email: rx }, { name: rx }];
    if (digits.length >= 4) {
      const candidates = new Set([digits]);
      if (digits.startsWith('0') && digits.length > 4) candidates.add(digits.slice(1));
      if (digits.startsWith('254') && digits.length > 6) candidates.add(digits.slice(3));
      for (const p of candidates) {
        orClauses.push({ phone: { $regex: p, $options: 'i' } });
      }
    }

    const items = await User.aggregate([
      { $match: { $or: orClauses } },
      { $sort: { lastLogin: -1, createdAt: -1 } },
      { $limit: limit },
      { $lookup: {
        from: Organization.collection.collectionName,
        localField: 'organization',
        foreignField: '_id',
        as: 'org',
        pipeline: [{ $project: { name: 1, slug: 1, plan: 1, subscriptionStatus: 1 } }],
      } },
      { $project: {
        _id: 1, email: 1, name: 1, phone: 1, role: 1, status: 1, isActive: 1,
        emailVerified: 1, lastLogin: 1, createdAt: 1,
        organization: { $arrayElemAt: ['$org', 0] },
      } },
    ]);

    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── WRITE ACTIONS ──────────────────────────────────────────────────────────
// Three intentionally narrow operator actions. Editing arbitrary fields stays
// off the table — that's what makes this dashboard safer than raw Atlas.

// POST /api/admin/orgs/:id/extend-trial   body: { days: 1..90 }
// Pushes trialEndsAt out by N days. If the org is currently 'expired', flips
// status back to 'trialing' so they regain access. Refuses on paid orgs (has a
// Paystack subscription code) — extending a trial there is meaningless and
// would confuse the billing flow.
router.post('/orgs/:id/extend-trial', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid org id' });
    }
    const days = Number(req.body?.days);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return res.status(400).json({ message: 'days must be between 1 and 90' });
    }

    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ message: 'Org not found' });

    if (org.paystackSubscriptionCode) {
      return res.status(400).json({ message: 'This org has an active Paystack subscription; extend-trial is for trial/expired orgs only.' });
    }
    if (!['trialing', 'expired'].includes(org.subscriptionStatus)) {
      return res.status(400).json({ message: `Cannot extend trial on a '${org.subscriptionStatus}' subscription.` });
    }

    // Anchor on max(now, current trialEndsAt) so an extension during an active
    // trial adds days on top, while an extension after expiry restarts from now.
    const base = org.trialEndsAt && new Date(org.trialEndsAt) > new Date()
      ? new Date(org.trialEndsAt)
      : new Date();
    const newEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    org.trialEndsAt = newEnd;
    if (org.subscriptionStatus === 'expired') org.subscriptionStatus = 'trialing';
    await org.save();

    console.log(`[admin] ${req.user.email} extended trial on org ${org.slug || org._id} by ${days}d → ${newEnd.toISOString()}`);

    res.json({
      message: `Trial extended by ${days} day${days === 1 ? '' : 's'}.`,
      trialEndsAt: org.trialEndsAt,
      subscriptionStatus: org.subscriptionStatus,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/orgs/:id/grant-credits   body: { ai?: number, pdf?: number, note?: string }
// Adds to the carry-indefinitely overflow pools (purchasedCredits / purchasedPdfPages).
// We deliberately don't touch aiCreditsLimit — that resets on the 1st, so a grant
// there would silently disappear. Both fields are charged AFTER the monthly allowance,
// so a grant survives until actually used.
router.post('/orgs/:id/grant-credits', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid org id' });
    }
    const ai = Number(req.body?.ai) || 0;
    const pdf = Number(req.body?.pdf) || 0;
    const note = (req.body?.note || '').toString().slice(0, 200);

    if (!Number.isFinite(ai) || !Number.isFinite(pdf)) {
      return res.status(400).json({ message: 'ai/pdf must be numbers' });
    }
    if (ai < 0 || pdf < 0 || ai > 100000 || pdf > 100000) {
      return res.status(400).json({ message: 'ai/pdf must be between 0 and 100000' });
    }
    if (ai === 0 && pdf === 0) {
      return res.status(400).json({ message: 'Specify at least one of ai or pdf > 0' });
    }

    const inc = {};
    if (ai > 0) inc.purchasedCredits = ai;
    if (pdf > 0) inc.purchasedPdfPages = pdf;

    const org = await Organization.findByIdAndUpdate(
      req.params.id,
      { $inc: inc },
      { new: true }
    ).select('_id slug name purchasedCredits purchasedPdfPages aiCreditsUsed aiCreditsLimit');
    if (!org) return res.status(404).json({ message: 'Org not found' });

    console.log(`[admin] ${req.user.email} granted ${ai} AI / ${pdf} PDF to org ${org.slug || org._id}${note ? ` — ${note}` : ''}`);

    res.json({
      message: `Granted ${ai > 0 ? `${ai} AI credit${ai === 1 ? '' : 's'}` : ''}${ai > 0 && pdf > 0 ? ' + ' : ''}${pdf > 0 ? `${pdf} PDF page${pdf === 1 ? '' : 's'}` : ''}.`,
      purchasedCredits: org.purchasedCredits,
      purchasedPdfPages: org.purchasedPdfPages,
      note,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/orgs/:id/force-cancel   body: { reason?: string, ignorePaystack?: boolean }
// Hard-stop. Disables the Paystack subscription (best-effort), marks the org
// cancelled, ends the paid period immediately so the paywall fires on the
// next non-GET, and bumps tokenVersion on every user so their JWTs revoke at
// once. Unlike the user-facing /billing/cancel, no grace period.
//
// If the Paystack disable call fails, we refuse to mark the org cancelled by
// default — otherwise the customer would keep being charged while we believed
// them cancelled. Pass ignorePaystack: true to override (e.g. when Paystack
// has already cancelled the sub on their side and we just need to sync state).
router.post('/orgs/:id/force-cancel', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid org id' });
    }
    const reason = (req.body?.reason || '').toString().slice(0, 500);
    const ignorePaystack = req.body?.ignorePaystack === true;

    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ message: 'Org not found' });
    if (org.subscriptionStatus === 'cancelled' && org.currentPeriodEnd && new Date(org.currentPeriodEnd) <= new Date()) {
      return res.status(400).json({ message: 'Org is already fully cancelled.' });
    }

    let paystackResult = 'no-subscription';
    if (org.paystackSubscriptionCode) {
      try {
        const { data: sub } = await paystack.fetchSubscription(org.paystackSubscriptionCode);
        await paystack.disableSubscription(sub.subscription_code, sub.email_token);
        paystackResult = 'disabled';
      } catch (e) {
        if (!ignorePaystack) {
          console.error(`[admin] Paystack disable failed for ${org.slug || org._id}:`, e.message);
          return res.status(502).json({
            message: `Paystack subscription disable failed: ${e.message}. Pass ignorePaystack: true to force the local cancel anyway.`,
          });
        }
        paystackResult = `failed-ignored: ${e.message}`;
      }
    }

    const now = new Date();
    org.subscriptionStatus = 'cancelled';
    org.currentPeriodEnd = now;
    org.pendingPlan = null;
    await org.save();

    // Force-logout every user in the org. tokenVersion bump invalidates their
    // existing JWTs the next time they hit any protected route.
    const tokResult = await User.updateMany(
      { organization: org._id },
      { $inc: { tokenVersion: 1 } }
    );

    console.log(`[admin] ${req.user.email} FORCE-CANCELLED org ${org.slug || org._id} (paystack: ${paystackResult}, sessions revoked: ${tokResult.modifiedCount})${reason ? ` — reason: ${reason}` : ''}`);

    res.json({
      message: 'Organization cancelled. Paywall is now in effect and all sessions have been revoked.',
      paystack: paystackResult,
      sessionsRevoked: tokResult.modifiedCount,
      subscriptionStatus: org.subscriptionStatus,
      currentPeriodEnd: org.currentPeriodEnd,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/orgs/:id/change-plan
// body: { plan, annual?, syncLimits?, extendDays?, reason? }
// Forces an org onto a different plan — without going through Paystack
// checkout. Used for goodwill upgrades, enterprise hand-rolls, or correcting
// a webhook that didn't land. By default this also re-seeds aiCreditsLimit /
// pdfPagesLimit / whiteLabel from PLANS[plan] (matching what the upgrade
// webhook does) so the new tier's limits take effect immediately. Pass
// syncLimits: false to leave existing limits intact (e.g. for enterprise
// orgs with custom-negotiated allowances).
router.post('/orgs/:id/change-plan', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid org id' });
    }
    const { plan, annual, syncLimits = true, extendDays, reason } = req.body || {};
    if (!plan || !PLANS[plan]) {
      return res.status(400).json({ message: `Unknown plan. Must be one of: ${Object.keys(PLANS).join(', ')}` });
    }

    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ message: 'Org not found' });

    const planConfig = PLANS[plan];
    const previousPlan = org.plan;
    const previousStatus = org.subscriptionStatus;

    org.plan = plan;
    if (typeof annual === 'boolean') org.annual = annual;

    if (syncLimits) {
      // Carry the unused fraction of the current allowance forward so a
      // mid-month upgrade isn't penalised — but only if we're *raising* the
      // limit. Downgrades hard-cap to the new allowance.
      if (plan !== 'trial') {
        if (planConfig.aiCredits > (org.aiCreditsLimit || 0)) {
          // upgrade: keep used count, raise the cap
          org.aiCreditsLimit = planConfig.aiCredits;
        } else {
          // downgrade: clamp used count to new cap
          org.aiCreditsLimit = planConfig.aiCredits;
          if (org.aiCreditsUsed > planConfig.aiCredits) {
            org.aiCreditsUsed = planConfig.aiCredits;
          }
        }
        org.pdfPagesLimit = planConfig.pdfPagesPerMonth;
      }
      org.whiteLabel = !!planConfig.whiteLabel;
    }

    // If this is a paid plan and the org has no current period yet, give them
    // a fresh 30-day window so the paywall doesn't trip on the next request.
    // For trial reverts, push the trial back out by extendDays if provided.
    if (plan === 'trial') {
      org.subscriptionStatus = 'trialing';
      if (extendDays && Number(extendDays) > 0) {
        const base = org.trialEndsAt && new Date(org.trialEndsAt) > new Date()
          ? new Date(org.trialEndsAt)
          : new Date();
        org.trialEndsAt = new Date(base.getTime() + Number(extendDays) * 24 * 60 * 60 * 1000);
      }
    } else {
      // Paid plan: mark active and ensure the period extends at least 30 days
      // out (or 365 if annual). Don't shrink an existing period — only extend.
      org.subscriptionStatus = 'active';
      const months = annual ? 12 : 1;
      const candidate = new Date();
      candidate.setMonth(candidate.getMonth() + months);
      if (!org.currentPeriodEnd || new Date(org.currentPeriodEnd) < candidate) {
        org.currentPeriodEnd = candidate;
      }
    }

    await org.save();

    console.log(`[admin] ${req.user.email} changed plan on org ${org.slug || org._id}: ${previousPlan}/${previousStatus} → ${org.plan}/${org.subscriptionStatus}${reason ? ` — reason: ${reason}` : ''}`);

    res.json({
      message: `Plan changed to ${planConfig.label}.`,
      plan: org.plan,
      annual: org.annual,
      subscriptionStatus: org.subscriptionStatus,
      currentPeriodEnd: org.currentPeriodEnd,
      trialEndsAt: org.trialEndsAt,
      aiCreditsLimit: org.aiCreditsLimit,
      pdfPagesLimit: org.pdfPagesLimit,
      whiteLabel: org.whiteLabel,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/orgs/:id/reset-counters
// body: { ai?: bool, pdf?: bool, quotes?: bool, reason? }
// Mid-cycle reset for the monthly counters. Useful when a bug burned credits
// (zero out aiCreditsUsed) or when an operator needs to retry a CSV import
// without waiting for the 1st of the month. Does NOT touch the carry-pool
// (purchasedCredits / purchasedPdfPages) — that's the grant-credits action.
router.post('/orgs/:id/reset-counters', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid org id' });
    }
    const { ai = false, pdf = false, quotes = false, reason } = req.body || {};
    if (!ai && !pdf && !quotes) {
      return res.status(400).json({ message: 'Specify at least one of ai, pdf, quotes' });
    }

    const set = {};
    const resets = [];
    if (ai)     { set.aiCreditsUsed = 0;  resets.push('ai'); }
    if (pdf)    { set.pdfPagesUsed = 0;   resets.push('pdf'); }
    if (quotes) { set.quotesThisMonth = 0; resets.push('quotes'); }

    const org = await Organization.findByIdAndUpdate(
      req.params.id,
      { $set: set },
      { new: true }
    ).select('_id slug name aiCreditsUsed pdfPagesUsed quotesThisMonth');
    if (!org) return res.status(404).json({ message: 'Org not found' });

    console.log(`[admin] ${req.user.email} reset counters on org ${org.slug || org._id}: ${resets.join(', ')}${reason ? ` — ${reason}` : ''}`);

    res.json({
      message: `Reset ${resets.join(' + ')} to zero.`,
      aiCreditsUsed: org.aiCreditsUsed,
      pdfPagesUsed: org.pdfPagesUsed,
      quotesThisMonth: org.quotesThisMonth,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/orgs/:id/rotate-api-key
// Mints a new API key for the org's external integrations (n8n, Zapier, etc.)
// and invalidates the old one. The owner can do this from settings too;
// providing it here is useful when the owner is locked out or the key has
// leaked and we want to act before they can.
router.post('/orgs/:id/rotate-api-key', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid org id' });
    }
    const apiKey = 'sk_' + crypto.randomBytes(24).toString('hex');
    const org = await Organization.findByIdAndUpdate(
      req.params.id,
      { apiKey },
      { new: true }
    ).select('_id slug name apiKey');
    if (!org) return res.status(404).json({ message: 'Org not found' });

    console.log(`[admin] ${req.user.email} rotated API key on org ${org.slug || org._id}`);

    res.json({ message: 'API key rotated.', apiKey: org.apiKey });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/orgs/:id/toggle-white-label   body: { enabled: bool, reason? }
// One-off override for the white-label flag, independent of the plan default.
// Useful for goodwill comps (give a Pro org white-label as a sweetener) or
// pulling it from an org that hasn't paid for the tier the flag implies.
router.post('/orgs/:id/toggle-white-label', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid org id' });
    }
    const enabled = req.body?.enabled === true;
    const reason = (req.body?.reason || '').toString().slice(0, 200);
    const org = await Organization.findByIdAndUpdate(
      req.params.id,
      { whiteLabel: enabled },
      { new: true }
    ).select('_id slug name whiteLabel');
    if (!org) return res.status(404).json({ message: 'Org not found' });

    console.log(`[admin] ${req.user.email} set whiteLabel=${enabled} on org ${org.slug || org._id}${reason ? ` — ${reason}` : ''}`);

    res.json({ message: `White-label ${enabled ? 'enabled' : 'disabled'}.`, whiteLabel: org.whiteLabel });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── User-level admin actions ───────────────────────────────────────────────

// POST /api/admin/users/:id/verify-email
// Manually mark a user's email as verified — for cases where the verify link
// was lost / clicked from the wrong device / the user is yelling at support.
router.post('/users/:id/verify-email', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { emailVerified: true, $unset: { verifyToken: '' } },
      { new: true }
    ).select('email emailVerified organization');
    if (!user) return res.status(404).json({ message: 'User not found' });

    console.log(`[admin] ${req.user.email} marked ${user.email} as email-verified`);
    res.json({ message: `Marked ${user.email} as verified.`, emailVerified: user.emailVerified });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/users/:id/resend-invite
// Re-issues an invite token (48h expiry) and re-sends the invite email.
// Only for users currently in 'pending' status — fully active members don't
// need a new invite link, they need a password reset.
router.post('/users/:id/resend-invite', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.status !== 'pending') {
      return res.status(400).json({ message: `User is '${user.status}', not 'pending' — use password reset instead.` });
    }

    user.inviteToken = crypto.randomBytes(32).toString('hex');
    user.inviteTokenExpires = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await user.save();

    const org = await Organization.findById(user.organization).select('name');
    const inviteUrl = `${process.env.CLIENT_URL}/accept-invite?token=${user.inviteToken}`;

    try {
      await sendEmail({
        to: user.email,
        subject: `You're invited to join ${org?.name || 'SafiriPro'}`,
        html: inviteEmail({
          inviterName: req.user.name || 'SafiriPro Support',
          orgName: org?.name || 'SafiriPro',
          inviteUrl,
        }),
      });
    } catch (mailErr) {
      // Re-issued token is already saved — failing to email is recoverable.
      console.error(`[admin] resend-invite email failed for ${user.email}:`, mailErr.message);
      return res.status(502).json({ message: `Invite token reset, but email failed: ${mailErr.message}` });
    }

    console.log(`[admin] ${req.user.email} re-sent invite to ${user.email}`);
    res.json({ message: `Invite resent to ${user.email}.`, inviteTokenExpires: user.inviteTokenExpires });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/users/:id/set-active   body: { isActive: bool, reason? }
// Disable a user (block login) or re-enable them. Bumps tokenVersion on
// disable so any in-flight JWTs stop working at once.
router.post('/users/:id/set-active', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }
    const isActive = req.body?.isActive === true;
    const reason = (req.body?.reason || '').toString().slice(0, 200);

    const update = { isActive };
    const ops = { $set: update };
    if (!isActive) ops.$inc = { tokenVersion: 1 };

    const user = await User.findByIdAndUpdate(req.params.id, ops, { new: true })
      .select('email isActive');
    if (!user) return res.status(404).json({ message: 'User not found' });

    console.log(`[admin] ${req.user.email} set isActive=${isActive} on ${user.email}${reason ? ` — ${reason}` : ''}`);
    res.json({ message: `${user.email} ${isActive ? 'enabled' : 'disabled'}.`, isActive: user.isActive });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/search-logs ─────────────────────────────────────────────
// Cross-org view of every /api/search call (auto-pruned after 90 days). Used
// to spot patterns ("most queries are diagnostic", "operators keep asking
// about cancellations") and to find queries that returned nothing so we can
// fix the parser or the inventory.
//
// Filters: q (substring on raw query), intent, outcome, orgId, from, to.
// Pagination: page (default 1), limit (default 50, max 200).
router.get('/search-logs', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.intent) filter.intent = req.query.intent;
    if (req.query.outcome) filter.outcome = req.query.outcome;
    if (req.query.orgId) {
      try { filter.organization = new mongoose.Types.ObjectId(String(req.query.orgId)); } catch { /* invalid id */ }
    }
    if (req.query.q) {
      const escapedQ = req.query.q.toString().trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.query = { $regex: escapedQ, $options: 'i' };
    }
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const [items, total] = await Promise.all([
      SearchLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('organization', 'name plan subscriptionStatus')
        .populate('user', 'name email')
        .lean(),
      SearchLog.countDocuments(filter),
    ]);

    res.json({ items, total, page, limit });
  } catch (err) {
    console.error('[admin/search-logs] failed:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/search-logs/stats ────────────────────────────────────────
// Lightweight aggregates for the dashboard hero strip — counts last 7d/30d,
// breakdown by intent, breakdown by outcome, top destinations, top mustHave
// terms. Always org-scoped via the same filter as /search-logs.
router.get('/search-logs/stats', async (req, res) => {
  try {
    const ago7 = daysAgo(7);
    const ago30 = daysAgo(30);

    const baseMatch = {};
    if (req.query.orgId) {
      try { baseMatch.organization = new mongoose.Types.ObjectId(String(req.query.orgId)); } catch { /* invalid id */ }
    }

    const [counts, byIntent, byOutcome, topDestinations, topMustHave, zeroResultQueries] = await Promise.all([
      SearchLog.aggregate([{ $match: baseMatch }, { $facet: {
        total: [{ $count: 'n' }],
        last7d: [{ $match: { createdAt: { $gte: ago7 } } }, { $count: 'n' }],
        last30d: [{ $match: { createdAt: { $gte: ago30 } } }, { $count: 'n' }],
      } }]),
      SearchLog.aggregate([
        { $match: { ...baseMatch, createdAt: { $gte: ago30 } } },
        { $group: { _id: '$intent', count: { $sum: 1 } } },
      ]),
      SearchLog.aggregate([
        { $match: { ...baseMatch, createdAt: { $gte: ago30 } } },
        { $group: { _id: '$outcome', count: { $sum: 1 } } },
      ]),
      SearchLog.aggregate([
        { $match: { ...baseMatch, createdAt: { $gte: ago30 }, 'parsed.destinationName': { $ne: null } } },
        { $group: { _id: '$parsed.destinationName', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      SearchLog.aggregate([
        { $match: { ...baseMatch, createdAt: { $gte: ago30 } } },
        { $unwind: '$parsed.mustHave' },
        { $group: { _id: { $toLower: '$parsed.mustHave' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      SearchLog.aggregate([
        // Queries that returned nothing — the high-signal feedback loop for
        // "what's the parser/inventory missing?".
        { $match: { ...baseMatch, createdAt: { $gte: ago30 }, outcome: 'no_results' } },
        { $group: { _id: { $toLower: '$query' }, count: { $sum: 1 }, last: { $max: '$createdAt' } } },
        { $sort: { count: -1, last: -1 } },
        { $limit: 10 },
      ]),
    ]);

    res.json({
      total: num(counts[0]?.total),
      last7d: num(counts[0]?.last7d),
      last30d: num(counts[0]?.last30d),
      byIntent: groupToObj(byIntent),
      byOutcome: groupToObj(byOutcome),
      topDestinations: topDestinations.map(d => ({ name: d._id, count: d.count })),
      topMustHave: topMustHave.map(d => ({ term: d._id, count: d.count })),
      zeroResultQueries: zeroResultQueries.map(d => ({ query: d._id, count: d.count, last: d.last })),
    });
  } catch (err) {
    console.error('[admin/search-logs/stats] failed:', err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
