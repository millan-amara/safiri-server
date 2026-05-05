import { Router } from 'express';
import mongoose from 'mongoose';
import Organization from '../models/Organization.js';
import User from '../models/User.js';
import AiUsageLog from '../models/AiUsageLog.js';
import Quote from '../models/Quote.js';
import { Deal } from '../models/Deal.js';
import { protect, requireSuperAdmin } from '../middleware/auth.js';
import * as paystack from '../services/paystack.js';

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
    if (req.query.q) filter.name = { $regex: req.query.q, $options: 'i' };

    // Allowlist sortable fields — anything else falls back to createdAt to
    // avoid arbitrary-field sorts hitting unindexed columns.
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
          pipeline: [{ $project: { email: 1, name: 1, lastLogin: 1 } }],
        } },
        { $lookup: {
          from: User.collection.collectionName,
          let: { orgId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$organization', '$$orgId'] } } },
            { $count: 'n' },
          ],
          as: 'userCountAgg',
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
          createdAt: 1,
          owner: { $arrayElemAt: ['$ownerUser', 0] },
          userCount: { $ifNull: [{ $arrayElemAt: ['$userCountAgg.n', 0] }, 0] },
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
// Single-org drill-down: full doc + members + counts + recent AI calls.
router.get('/orgs/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid org id' });
    }
    const org = await Organization.findById(req.params.id).lean();
    if (!org) return res.status(404).json({ message: 'Org not found' });

    const [members, quoteCount, dealCount, recentAi] = await Promise.all([
      User.find({ organization: org._id })
        .select('-password -resetToken -verifyToken -inviteToken')
        .lean(),
      Quote.countDocuments({ organization: org._id }),
      Deal.countDocuments({ organization: org._id }),
      AiUsageLog.find({ organizationId: org._id })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean(),
    ]);

    res.json({ org, members, quoteCount, dealCount, recentAi });
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

export default router;
