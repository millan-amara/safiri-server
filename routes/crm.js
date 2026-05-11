import { Router } from 'express';
import Contact from '../models/Contact.js';
import { Deal, Pipeline } from '../models/Deal.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import Organization from '../models/Organization.js';
import ScheduledMessage from '../models/ScheduledMessage.js';
import Invoice from '../models/Invoice.js';
import Quote from '../models/Quote.js';
import { computeSendAt } from './scheduledMessages.js';
import { buildInvoicePayloadFromDeal, nextInvoiceNumber } from '../services/invoiceBuilder.js';
import { fireInvoiceWebhook } from '../services/invoiceWebhook.js';
import { autoGenerateVouchersOnDealWon } from '../services/voucherGenerator.js';
import { protect, authorize } from '../middleware/auth.js';
import {
  getAccessiblePipelineIds,
  userCanSeePipeline,
  requireDealAccess,
  canDeleteDeal,
} from '../middleware/access.js';
import { triggerAutomation } from '../automations/engine.js';
import { notify } from '../utils/notify.js';
import { createNotification } from './notifications.js';
import { requirePipelineQuota, requireTrialContactQuota } from '../middleware/partnerQuota.js';

const router = Router();

const ADMIN_ROLES = ['owner', 'admin'];
const isAdmin = (user) => ADMIN_ROLES.includes(user.role);

// Build per-pipeline $or clauses for filtering deals by stage *type*.
// Returns { won: [...], lost: [...], open: [...] } where each entry is
// `{ pipeline: id, stage: { $in: [stageNames] } }`. This is the source of
// truth for "which stages count as Won/Lost" across pipelines that use
// different stage names (e.g. Marketing's "Handed to Sales" = won).
async function buildStageTypeOrs(organizationId) {
  const pipelines = await Pipeline.find({ organization: organizationId, isActive: true })
    .select('stages').lean();
  const result = { won: [], lost: [], open: [] };
  for (const p of pipelines) {
    for (const t of ['won', 'lost', 'open']) {
      const names = (p.stages || [])
        .filter(s => (s.type || 'open') === t)
        .map(s => s.name);
      if (names.length > 0) {
        result[t].push({ pipeline: p._id, stage: { $in: names } });
      }
    }
  }
  return result;
}

// Compose a Mongo filter: baseFilter AND deal is in a stage of the given type.
// Returns a filter that matches nothing if no stages of that type exist anywhere.
function withStageType(baseFilter, stageOrs, type) {
  const clauses = stageOrs[type] || [];
  if (clauses.length === 0) return { ...baseFilter, _id: null };
  return { ...baseFilter, $or: clauses };
}

// ─── CONTACTS ────────────────────────────────────────
// Contacts are org-scoped, not pipeline-scoped — every authenticated user can read.
// Per the role matrix: agent+ can create/edit; only admin+ can delete.

router.get('/contacts', protect, async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const filter = { organization: req.organizationId, isActive: true };
    if (search) filter.$text = { $search: search };

    const contacts = await Contact.find(filter)
      .populate('assignedTo', 'name avatar')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await Contact.countDocuments(filter);

    res.json({ contacts, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/contacts/:id', protect, async (req, res) => {
  try {
    const contact = await Contact.findOne({ _id: req.params.id, organization: req.organizationId })
      .populate('assignedTo', 'name avatar');
    if (!contact) return res.status(404).json({ message: 'Contact not found' });

    // Filter the linked-deals/tasks listing by what this user is allowed to see.
    const accessiblePipelines = await getAccessiblePipelineIds(req.user);
    const dealFilter = { contact: contact._id, organization: req.organizationId };
    if (!isAdmin(req.user)) dealFilter.pipeline = { $in: accessiblePipelines };

    const deals = await Deal.find(dealFilter)
      .populate('pipeline', 'name')
      .sort({ createdAt: -1 });

    const dealIds = deals.map(d => d._id);
    const tasks = await Task.find({
      organization: req.organizationId,
      $or: [
        { contact: contact._id },
        { deal: { $in: dealIds } },
      ],
      status: { $ne: 'cancelled' },
    })
      .populate('assignedTo', 'name avatar')
      .populate('deal', 'title')
      .sort({ dueDate: 1 });

    res.json({ contact, deals, tasks });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Whitelist editable contact fields — keeps callers from setting
// organization/_id/createdBy/isActive directly via the body.
const CONTACT_EDITABLE_FIELDS = [
  'firstName', 'lastName', 'email', 'phone', 'company', 'position', 'country',
  'source', 'tags', 'notes', 'budget', 'interests', 'groupSize', 'customFields',
];
function pickContactFields(body) {
  const out = {};
  for (const f of CONTACT_EDITABLE_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

router.post('/contacts', protect, authorize('owner', 'admin', 'agent'), requireTrialContactQuota, async (req, res) => {
  try {
    const contact = await Contact.create({ ...pickContactFields(req.body), organization: req.organizationId });
    triggerAutomation('contact.created', { organizationId: req.organizationId, contact, userId: req.user._id });
    res.status(201).json(contact);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/contacts/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      pickContactFields(req.body),
      { new: true }
    );
    if (!contact) return res.status(404).json({ message: 'Not found' });
    res.json(contact);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/contacts/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    await Contact.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { isActive: false }
    );
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── PIPELINES ────────────────────────────────────────
// Visibility: every authenticated user can list, but the list is filtered to
// pipelines they have access to. Structural changes (create/update/delete) are admin-only.

router.get('/pipelines', protect, async (req, res) => {
  try {
    const baseFilter = { organization: req.organizationId, isActive: true };
    const filter = isAdmin(req.user)
      ? baseFilter
      : {
          ...baseFilter,
          $or: [
            { visibility: 'organization' },
            { visibility: 'members', members: req.user._id },
          ],
        };
    const pipelines = await Pipeline.find(filter);
    res.json({ pipelines });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Whitelist editable pipeline fields. Without this, a caller could overwrite
// `organization`, `isActive`, or arbitrary internal fields via the body.
const PIPELINE_EDITABLE_FIELDS = ['name', 'isDefault', 'stages', 'visibility', 'members'];
function pickPipelineFields(body) {
  const out = {};
  for (const f of PIPELINE_EDITABLE_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

router.post('/pipelines', protect, authorize('owner', 'admin'), requirePipelineQuota, async (req, res) => {
  try {
    const pipeline = await Pipeline.create({ ...pickPipelineFields(req.body), organization: req.organizationId });
    res.status(201).json(pipeline);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/pipelines/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    const pipeline = await Pipeline.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      pickPipelineFields(req.body),
      { new: true }
    );
    if (!pipeline) return res.status(404).json({ message: 'Not found' });
    res.json(pipeline);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/pipelines/:id', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    const pipeline = await Pipeline.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!pipeline) return res.status(404).json({ message: 'Not found' });
    if (pipeline.isDefault) return res.status(400).json({ message: 'Cannot delete the default pipeline' });

    await Pipeline.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ message: 'Pipeline deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── DEALS ────────────────────────────────────────
// Visibility filtered by accessible pipelines. Viewers read-only.
// Agents can create/edit in pipelines they have access to. Delete is policy-driven (canDeleteDeal).

router.get('/deals', protect, async (req, res) => {
  try {
    const { pipeline, stage, assignedTo, createdBy, page = 1, limit = 100 } = req.query;
    const filter = { organization: req.organizationId, isActive: true };

    const accessiblePipelines = await getAccessiblePipelineIds(req.user);

    if (pipeline) {
      // If the caller filters by a specific pipeline, check they can see it.
      const ok = accessiblePipelines.some(p => String(p) === String(pipeline));
      if (!ok) return res.status(403).json({ message: 'No access to this pipeline' });
      filter.pipeline = pipeline;
    } else if (!isAdmin(req.user)) {
      filter.pipeline = { $in: accessiblePipelines };
    }

    if (stage) filter.stage = stage;
    if (assignedTo) filter.assignedTo = assignedTo === 'me' ? req.user._id : assignedTo;
    if (createdBy) filter.createdBy = createdBy === 'me' ? req.user._id : createdBy;

    const deals = await Deal.find(filter)
      .populate('contact', 'firstName lastName email phone')
      .populate('assignedTo', 'name avatar')
      .populate('createdBy', 'name')
      .populate('pipeline', 'name stages')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await Deal.countDocuments(filter);

    res.json({ deals, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/deals/:id', protect, requireDealAccess(), async (req, res) => {
  try {
    const deal = await Deal.findById(req.deal._id)
      .populate('contact')
      .populate('createdBy', 'name avatar')
      .populate('assignedTo', 'name avatar email')
      .populate('pipeline', 'name stages')
      .populate('quotes')
      .populate('notes.createdBy', 'name avatar');

    // Auto-migrate old string notes to array
    if (!Array.isArray(deal.notes)) {
      const oldNote = deal.notes;
      deal.notes = [];
      if (oldNote && typeof oldNote === 'string' && oldNote.trim()) {
        deal.notes.push({ text: oldNote, createdBy: deal.assignedTo || deal.createdBy });
      }
      await deal.save();
    }

    const tasks = await Task.find({ deal: deal._id, organization: req.organizationId })
      .populate('assignedTo', 'name avatar')
      .sort({ dueDate: 1 });

    // Quotes are queried directly. The Deal.quotes[] back-reference array
    // exists in the schema but is never written to (each Quote keeps its own
    // `deal` pointer as the source of truth), so populating it always returns
    // [] and the panel looks empty even when quotes exist.
    const quotes = await Quote.find({
      deal: deal._id,
      organization: req.organizationId,
      isTemplate: { $ne: true },
    })
      .select('title quoteNumber status version createdAt pricing.totalPrice pricing.currency')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ deal, tasks, quotes });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/deals', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const pipelineId = req.body.pipeline;
    if (!pipelineId) return res.status(400).json({ message: 'Pipeline is required' });

    const pipeline = await Pipeline.findOne({
      _id: pipelineId,
      organization: req.organizationId,
      isActive: true,
    }).lean();
    if (!pipeline) return res.status(404).json({ message: 'Pipeline not found' });
    if (!userCanSeePipeline(req.user, pipeline)) {
      return res.status(403).json({ message: 'No access to this pipeline' });
    }

    const deal = await Deal.create({
      ...req.body,
      organization: req.organizationId,
      createdBy: req.user._id,
      activities: [{
        type: 'deal_created',
        description: `Deal created by ${req.user.name}`,
        createdBy: req.user._id,
      }],
    });
    const populated = await Deal.findById(deal._id)
      .populate('contact', 'firstName lastName email')
      .populate('assignedTo', 'name avatar')
      .populate('pipeline', 'name stages');

    triggerAutomation('deal.created', { organizationId: req.organizationId, deal, userId: req.user._id });

    if (deal.assignedTo) {
      User.findById(deal.assignedTo).select('name phone').lean()
        .then(assignee => notify({
          plan: req.organization?.plan,
          user: assignee,
          type: 'deal_assigned',
          payload: { dealTitle: deal.title },
        }))
        .catch(err => console.error('[notify] deal_assigned failed:', err.message));
    }

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/deals/:id', protect, authorize('owner', 'admin', 'agent'), requireDealAccess(), async (req, res) => {
  try {
    const existing = req.deal;

    // The pipeline whose stages we'll consult for type lookups. Defaults to the
    // deal's current pipeline (already loaded by requireDealAccess); replaced
    // with the target if the caller is moving the deal across pipelines.
    let targetPipeline = req.pipeline;

    // If the caller is moving the deal to a different pipeline, they must also have access to the target.
    if (req.body.pipeline && String(req.body.pipeline) !== String(existing.pipeline)) {
      const target = await Pipeline.findOne({
        _id: req.body.pipeline,
        organization: req.organizationId,
        isActive: true,
      }).lean();
      if (!target) return res.status(404).json({ message: 'Target pipeline not found' });
      if (!userCanSeePipeline(req.user, target)) {
        return res.status(403).json({ message: 'No access to target pipeline' });
      }
      targetPipeline = target;
    }

    if (req.body.stage && req.body.stage !== existing.stage) {
      existing.activities.push({
        type: 'stage_change',
        description: `${req.user.name} moved from "${existing.stage}" to "${req.body.stage}"`,
        createdBy: req.user._id,
      });

      // Look up the destination stage's semantic type. We rely on `type` rather
      // than name so custom-named pipelines (e.g. Marketing's "Handed to Sales")
      // still trigger the right won/lost flows.
      const targetStage = (targetPipeline?.stages || []).find(s => s.name === req.body.stage);
      const targetType = targetStage?.type || 'open';
      const isWon = targetType === 'won';
      const isLost = targetType === 'lost';

      if (isWon && !existing.wonAt) {
        req.body.wonAt = new Date();
      }
      if (isLost && !existing.lostAt) {
        req.body.lostAt = new Date();
      }

      triggerAutomation('deal.stage_changed', {
        organizationId: req.organizationId,
        deal: existing,
        userId: req.user._id,
        toStage: req.body.stage,
      });

      if (isWon) {
        triggerAutomation('deal.won', { organizationId: req.organizationId, deal: existing, userId: req.user._id });
        // ── Deal-won notification routing ─────────────────────────────────
        // Always notify the deal's original creator (closes the marketer
        // feedback loop) plus any users on org.preferences.dealWonNotifyUsers.
        // Skip the user who actually closed the deal — they don't need a ping.
        try {
          const recipientIds = new Set();
          if (existing.createdBy && String(existing.createdBy) !== String(req.user._id)) {
            recipientIds.add(String(existing.createdBy));
          }
          const extras = req.organization?.preferences?.dealWonNotifyUsers || [];
          for (const uid of extras) {
            const s = String(uid);
            if (s !== String(req.user._id)) recipientIds.add(s);
          }

          if (recipientIds.size > 0) {
            const recipients = await User.find({
              _id: { $in: [...recipientIds] },
              organization: req.organizationId,
              isActive: true,
            }).select('name phone email').lean();

            const closer = req.user.name || 'A teammate';
            const dealValue = existing.value
              ? `${existing.currency || 'USD'} ${Number(existing.value).toLocaleString()}`
              : null;

            for (const r of recipients) {
              createNotification({
                organization: req.organizationId,
                user: r._id,
                type: 'deal_won',
                title: `Deal won: ${existing.title}`,
                message: `${closer} marked this as Won.`,
                entityType: 'deal',
                entityId: existing._id,
              });
              const role = String(r._id) === String(existing.createdBy) ? 'original creator' : null;
              notify({
                plan: req.organization?.plan,
                user: r,
                type: 'deal_won',
                payload: { dealTitle: existing.title, byName: closer, role, value: dealValue },
              }).catch(err => console.error('[notify] deal_won failed:', err.message));
            }
          }
        } catch (err) {
          console.error('Deal-won notification routing failed:', err.message);
        }

        // ── Auto-draft an invoice on Won ───────────────────────────────────
        // Skipped if the org has disabled the preference, or if this deal
        // already has an invoice (e.g. operator generated one manually before
        // closing). Best-effort: any error logs but doesn't break the stage
        // transition or block the response.
        if (req.organization?.preferences?.autoGenerateInvoiceOnWon !== false) {
          try {
            const dupInvoice = await Invoice.findOne({ deal: existing._id }).select('_id').lean();
            if (!dupInvoice) {
              const populatedDeal = await Deal.findById(existing._id)
                .populate('contact', 'firstName lastName email phone company');
              const fullOrg = await Organization.findById(req.organizationId).lean();
              const payload = await buildInvoicePayloadFromDeal({
                deal: populatedDeal,
                org: fullOrg,
              });
              payload.invoiceNumber = await nextInvoiceNumber(req.organizationId);
              payload.createdBy = req.user._id;
              const autoInvoice = await Invoice.create(payload);
              fireInvoiceWebhook('invoice.created', autoInvoice);
            }
          } catch (err) {
            console.error('[crm] auto-invoice generation on Won failed:', err.message);
          }
        }

        // ── Auto-draft hotel vouchers on Won ───────────────────────────────
        // Off by default. The auto-generator picks the deal's single LIVE
        // quote (sent / viewed / accepted) — if there are 0 or >1 it bails
        // and notifies the operator to do it manually, because picking the
        // wrong quote could send a stale itinerary to the lodge. Vouchers
        // are always created as drafts: the lodge PRN still has to be added
        // by hand before the operator emails them out.
        if (req.organization?.preferences?.autoGenerateVouchersOnWon === true) {
          try {
            const populatedDeal = await Deal.findById(existing._id)
              .populate('contact', 'firstName lastName email phone company');
            const outcome = await autoGenerateVouchersOnDealWon({
              deal: populatedDeal,
              organizationId: req.organizationId,
              userId: req.user._id,
            });

            // Notify the deal closer regardless of outcome so they know what
            // (if anything) was generated and what they need to do next.
            const dealLink = { entityType: 'deal', entityId: existing._id };
            if (outcome.reason === 'created') {
              const n = outcome.created.length;
              const skipNote = outcome.skipped > 0 ? ` (${outcome.skipped} skipped — already existed)` : '';
              createNotification({
                organization: req.organizationId,
                user: req.user._id,
                type: 'system',
                title: `${n} voucher draft${n === 1 ? '' : 's'} created`,
                message: `From quote QT-${String(outcome.quoteNumber).padStart(4, '0')}${skipNote}. Confirm with each hotel and add the PRN before issuing.`,
                ...dealLink,
              });
            } else if (outcome.reason === 'multiple_quotes') {
              createNotification({
                organization: req.organizationId,
                user: req.user._id,
                type: 'system',
                title: 'Vouchers not auto-generated',
                message: `Deal has ${outcome.count} live quotes. Open the deal and generate vouchers from the right quote manually.`,
                ...dealLink,
              });
            } else if (outcome.reason === 'no_quote') {
              createNotification({
                organization: req.organizationId,
                user: req.user._id,
                type: 'system',
                title: 'Vouchers not auto-generated',
                message: 'No live quote on this deal. Generate vouchers manually if accommodation needs to be issued.',
                ...dealLink,
              });
            } else if (outcome.reason === 'no_hotels') {
              createNotification({
                organization: req.organizationId,
                user: req.user._id,
                type: 'system',
                title: 'No vouchers to generate',
                message: `Quote QT-${String(outcome.quoteNumber).padStart(4, '0')} has no hotel stays.`,
                ...dealLink,
              });
            }
          } catch (err) {
            console.error('[crm] auto-voucher generation on Won failed:', err.message);
          }
        }
      } else if (isLost) {
        triggerAutomation('deal.lost', { organizationId: req.organizationId, deal: existing, userId: req.user._id });
        // A lost deal shouldn't keep sending packing tips / review-requests.
        // Cancel any pending scheduled messages so the operator doesn't have
        // to remember to clean each one up manually.
        await ScheduledMessage.updateMany(
          { deal: existing._id, status: { $in: ['scheduled', 'overdue'] } },
          { $set: { status: 'cancelled' } },
        ).catch(err => console.error('[crm] cancel scheduled messages on Lost failed:', err.message));
      }
    }

    // Detect travel-date changes BEFORE Object.assign overwrites them. Used
    // below (after save) to recompute sendAt for any relative scheduled messages.
    const travelDatesChanged =
      (req.body.travelDates?.start &&
        new Date(req.body.travelDates.start).getTime() !==
          new Date(existing.travelDates?.start || 0).getTime()) ||
      (req.body.travelDates?.end &&
        new Date(req.body.travelDates.end).getTime() !==
          new Date(existing.travelDates?.end || 0).getTime());

    // Assignment change — three layers of validation:
    //   1. Org reassignment policy (agents only — admins always allowed)
    //   2. New assignee exists in the org
    //   3. New assignee has access to the target pipeline (otherwise the deal
    //      becomes invisible to them and notifications point at nothing they can open)
    if (req.body.assignedTo && req.body.assignedTo.toString() !== existing.assignedTo?.toString()) {
      // Policy enforcement for agents.
      if (!ADMIN_ROLES.includes(req.user.role)) {
        const policy = req.organization?.preferences?.agentDealReassign || 'own';
        if (policy === 'none') {
          return res.status(403).json({
            message: 'Only owners and admins can change deal assignments in this organization.',
            code: 'AGENT_REASSIGN_BLOCKED',
          });
        }
        if (policy === 'own') {
          const isCurrentAssignee = existing.assignedTo &&
            String(existing.assignedTo) === String(req.user._id);
          const isSelfClaim = !existing.assignedTo &&
            String(req.body.assignedTo) === String(req.user._id);
          if (!isCurrentAssignee && !isSelfClaim) {
            return res.status(403).json({
              message: 'You can only reassign deals currently assigned to you. Ask an admin to reassign deals owned by other teammates.',
              code: 'AGENT_REASSIGN_OWN_ONLY',
            });
          }
        }
      }

      const newAssignee = await User.findOne({
        _id: req.body.assignedTo,
        organization: req.organizationId,
        isActive: true,
      }).select('name phone email role').lean();
      if (!newAssignee) {
        return res.status(400).json({ message: 'Assignee not found in this organization' });
      }
      if (!userCanSeePipeline(newAssignee, targetPipeline)) {
        return res.status(400).json({
          message: `${newAssignee.name || 'That user'} doesn't have access to this pipeline. Add them as a pipeline member first.`,
          code: 'ASSIGNEE_NO_PIPELINE_ACCESS',
        });
      }

      try {
        const oldUser = existing.assignedTo
          ? await User.findById(existing.assignedTo).select('name phone email').lean()
          : null;
        existing.activities.push({
          type: 'assignment_change',
          description: `${req.user.name} reassigned from ${oldUser?.name || 'unassigned'} to ${newAssignee.name || 'unknown'}`,
          createdBy: req.user._id,
        });
        // Notify the new assignee so they pick up the work.
        notify({
          plan: req.organization?.plan,
          user: newAssignee,
          type: 'deal_assigned',
          payload: { dealTitle: existing.title },
        }).catch(err => console.error('[notify] deal_assigned (reassign) failed:', err.message));
        // Notify the previous assignee that the deal moved off their queue —
        // skip if they're the one making the change (no self-notification).
        if (oldUser && String(oldUser._id) !== String(req.user._id)) {
          notify({
            plan: req.organization?.plan,
            user: oldUser,
            type: 'deal_unassigned',
            payload: { dealTitle: existing.title, newAssigneeName: newAssignee.name || 'someone else' },
          }).catch(err => console.error('[notify] deal_unassigned failed:', err.message));
        }
      } catch (err) { /* silent — notifications are best-effort */ }
    }

    // Whitelist editable fields. Without this, an authenticated user could
    // PUT { organization: <other> } to migrate a deal cross-tenant, or set
    // createdBy / wonAt / lostAt / activities directly to spoof history.
    const DEAL_EDITABLE_FIELDS = [
      'title', 'contact', 'pipeline', 'stage', 'destination', 'travelDates',
      'groupSize', 'budget', 'tripType', 'interests', 'specialRequests',
      'value', 'currency', 'assignedTo', 'tags', 'wonAt', 'lostAt',
    ];
    for (const f of DEAL_EDITABLE_FIELDS) {
      if (req.body[f] !== undefined) existing[f] = req.body[f];
    }
    await existing.save();

    // If travel dates moved, recompute sendAt for any relative scheduled
    // messages on this deal. Messages whose new send time is in the past
    // get flagged 'overdue' so the operator decides whether to send anyway.
    if (travelDatesChanged) {
      try {
        const relativeMessages = await ScheduledMessage.find({
          deal: existing._id,
          status: { $in: ['scheduled', 'overdue'] },
          'timing.mode': { $in: ['before_travel_start', 'after_travel_end'] },
        });
        const sendTimeOpts = {
          hour: req.organization?.preferences?.scheduledMessageHour ?? 9,
          timezone: req.organization?.preferences?.scheduledMessageTimezone || 'Africa/Nairobi',
        };
        const now = new Date();
        for (const msg of relativeMessages) {
          const newSendAt = computeSendAt(msg.timing, existing, sendTimeOpts);
          if (!newSendAt) continue;
          msg.sendAt = newSendAt;
          msg.status = newSendAt < now ? 'overdue' : 'scheduled';
          await msg.save();
        }
      } catch (err) {
        console.error('[crm] recompute scheduled messages on date change failed:', err.message);
      }
    }

    const populated = await Deal.findById(existing._id)
      .populate('contact', 'firstName lastName email')
      .populate('assignedTo', 'name avatar')
      .populate('pipeline', 'name stages');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/deals/:id', protect, requireDealAccess(), async (req, res) => {
  try {
    if (!canDeleteDeal(req.user, req.deal, req.organization)) {
      return res.status(403).json({ message: 'You do not have permission to delete this deal' });
    }
    req.deal.isActive = false;
    await req.deal.save();
    // Cancel pending scheduled messages — an archived deal shouldn't keep emailing.
    await ScheduledMessage.updateMany(
      { deal: req.deal._id, status: { $in: ['scheduled', 'overdue'] } },
      { $set: { status: 'cancelled' } },
    ).catch(err => console.error('[crm] cancel scheduled messages on delete failed:', err.message));
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add activity to deal — non-viewer only
router.post('/deals/:id/activities', protect, authorize('owner', 'admin', 'agent'), requireDealAccess(), async (req, res) => {
  try {
    const deal = req.deal;
    deal.activities.push({ ...req.body, createdBy: req.user._id });
    await deal.save();
    res.json(deal);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add note to deal — non-viewer only
router.post('/deals/:id/notes', protect, authorize('owner', 'admin', 'agent'), requireDealAccess(), async (req, res) => {
  try {
    const deal = req.deal;

    if (!Array.isArray(deal.notes)) {
      const oldNote = deal.notes;
      deal.notes = [];
      if (oldNote && typeof oldNote === 'string' && oldNote.trim()) {
        deal.notes.push({ text: oldNote, createdBy: req.user._id });
      }
    }

    deal.notes.push({ text: req.body.text, createdBy: req.user._id });
    await deal.save();

    const populated = await Deal.findById(deal._id).populate('notes.createdBy', 'name avatar');
    res.json({ notes: populated.notes });
  } catch (error) {
    console.error('Add note error:', error.message);
    res.status(500).json({ message: error.message });
  }
});

// Delete note — non-viewer only
router.delete('/deals/:id/notes/:noteId', protect, authorize('owner', 'admin', 'agent'), requireDealAccess(), async (req, res) => {
  try {
    await Deal.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { $pull: { notes: { _id: req.params.noteId } } }
    );
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Pin/unpin note — non-viewer only
router.put('/deals/:id/notes/:noteId', protect, authorize('owner', 'admin', 'agent'), requireDealAccess(), async (req, res) => {
  try {
    const deal = req.deal;
    const note = deal.notes.id(req.params.noteId);
    if (!note) return res.status(404).json({ message: 'Note not found' });

    note.isPinned = !note.isPinned;
    await deal.save();
    res.json({ note });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── TASKS ────────────────────────────────────────
// Tasks linked to a deal inherit that deal's pipeline access.
// Tasks not linked to a deal are visible org-wide.
// Agents can edit/delete only tasks they created or are assigned to. Viewers read-only.

router.get('/tasks', protect, async (req, res) => {
  try {
    const { status, assignedTo, deal } = req.query;
    const filter = { organization: req.organizationId };
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (deal) filter.deal = deal;

    if (!isAdmin(req.user)) {
      const accessiblePipelines = await getAccessiblePipelineIds(req.user);
      const accessibleDeals = await Deal.find({
        organization: req.organizationId,
        pipeline: { $in: accessiblePipelines },
        isActive: true,
      }).select('_id').lean();
      const accessibleDealIds = accessibleDeals.map(d => d._id);

      // A task is visible to a non-admin if any of these is true:
      //   - it has no deal (general org task)
      //   - its deal is in their accessible pipelines
      //   - they are the assignee or creator (regardless of deal access)
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { deal: { $in: [null, undefined] } },
            { deal: { $exists: false } },
            { deal: { $in: accessibleDealIds } },
            { assignedTo: req.user._id },
            { createdBy: req.user._id },
          ],
        },
      ];
    }

    const tasks = await Task.find(filter)
      .populate('assignedTo', 'name avatar')
      .populate('deal', 'title')
      .populate('contact', 'firstName lastName')
      .sort({ dueDate: 1 });
    res.json({ tasks });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Whitelist editable task fields — keeps callers from setting createdBy /
// organization / completedAt / reminderSentAt / etc. directly via the body.
const TASK_EDITABLE_FIELDS = [
  'title', 'description', 'status', 'priority', 'dueDate',
  'assignedTo', 'deal', 'contact', 'reminderHours', 'tags',
];
function pickTaskFields(body) {
  const out = {};
  for (const f of TASK_EDITABLE_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

router.post('/tasks', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    // If the task is linked to a deal, the user must have access to that deal's pipeline.
    if (req.body.deal) {
      const deal = await Deal.findOne({
        _id: req.body.deal,
        organization: req.organizationId,
        isActive: true,
      }).select('pipeline').lean();
      if (!deal) return res.status(404).json({ message: 'Linked deal not found' });

      const pipeline = await Pipeline.findOne({
        _id: deal.pipeline,
        organization: req.organizationId,
      }).lean();
      if (!pipeline || !userCanSeePipeline(req.user, pipeline)) {
        return res.status(403).json({ message: 'No access to the linked deal' });
      }
    }

    const task = await Task.create({
      ...pickTaskFields(req.body),
      organization: req.organizationId,
      createdBy: req.user._id,
    });
    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name avatar')
      .populate('deal', 'title');

    if (task.assignedTo) {
      triggerAutomation('task.assigned', { organizationId: req.organizationId, task, userId: req.user._id });

      User.findById(task.assignedTo).select('name phone').lean()
        .then(assignee => notify({
          plan: req.organization?.plan,
          user: assignee,
          type: 'task_assigned',
          payload: { taskTitle: task.title, dueDate: task.dueDate },
        }))
        .catch(err => console.error('[notify] task_assigned failed:', err.message));
    }

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/tasks/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const prior = await Task.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!prior) return res.status(404).json({ message: 'Not found' });

    // Agents can only edit tasks they created or are assigned to.
    if (!isAdmin(req.user)) {
      const isOwner =
        String(prior.createdBy) === String(req.user._id) ||
        String(prior.assignedTo) === String(req.user._id);
      if (!isOwner) return res.status(403).json({ message: 'You can only edit your own tasks' });
    }

    const update = pickTaskFields(req.body);
    if (update.status === 'done') update.completedAt = new Date();

    const dueDateChanged = update.dueDate !== undefined &&
      new Date(update.dueDate || 0).getTime() !== new Date(prior.dueDate || 0).getTime();
    const reminderHoursChanged = update.reminderHours !== undefined &&
      update.reminderHours !== prior.reminderHours;
    if (dueDateChanged || reminderHoursChanged) {
      update.reminderSentAt = null;
    }

    const task = await Task.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      update,
      { new: true }
    ).populate('assignedTo', 'name avatar');

    const newAssignee = task.assignedTo?._id || task.assignedTo;
    const priorAssignee = prior.assignedTo;
    if (newAssignee && String(newAssignee) !== String(priorAssignee || '')) {
      triggerAutomation('task.assigned', { organizationId: req.organizationId, task, userId: req.user._id });
    }

    res.json(task);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/tasks/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const task = await Task.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!task) return res.status(404).json({ message: 'Not found' });

    if (!isAdmin(req.user)) {
      const isOwner =
        String(task.createdBy) === String(req.user._id) ||
        String(task.assignedTo) === String(req.user._id);
      if (!isOwner) return res.status(403).json({ message: 'You can only delete your own tasks' });
    }

    await Task.findByIdAndDelete(task._id);
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── MY SOURCED LEADS ───────────────────────────────
// Per-user view of "what happened to leads I sourced" (Deal.createdBy === me).
// Closes the feedback loop for marketers handing leads off to sales (and for
// salespeople tracking their own inbound). Counts across ALL pipelines.

router.get('/my-leads-stats', protect, async (req, res) => {
  try {
    const orgId = req.organizationId;
    const myId = req.user._id;
    const baseFilter = { organization: orgId, createdBy: myId, isActive: true };

    const stageOrs = await buildStageTypeOrs(orgId);

    const [totalSourced, inProgress, wonByMe, wonByTeammate, lostCount, recentActive] = await Promise.all([
      Deal.countDocuments(baseFilter),
      Deal.countDocuments(withStageType(baseFilter, stageOrs, 'open')),
      Deal.countDocuments(withStageType({ ...baseFilter, assignedTo: myId }, stageOrs, 'won')),
      Deal.countDocuments(withStageType({ ...baseFilter, assignedTo: { $ne: myId } }, stageOrs, 'won')),
      Deal.countDocuments(withStageType(baseFilter, stageOrs, 'lost')),
      Deal.find(baseFilter)
        .populate('contact', 'firstName lastName')
        .populate('assignedTo', 'name avatar')
        .populate('pipeline', 'name')
        .sort({ updatedAt: -1 })
        .limit(5)
        .lean(),
    ]);

    const wonTotal = wonByMe + wonByTeammate;
    const closedTotal = wonTotal + lostCount;
    const conversionRate = closedTotal > 0 ? Math.round((wonTotal / closedTotal) * 100) : 0;

    res.json({
      totalSourced,
      inProgress,
      won: wonTotal,
      wonByMe,
      wonByTeammate,
      lost: lostCount,
      conversionRate,
      recentActive,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── DASHBOARD STATS ────────────────────────────────
// Filtered by accessible pipelines for non-admins. Viewers see counts only for
// pipelines they have access to (a viewer with no membership sees near-zero stats).

router.get('/stats', protect, async (req, res) => {
  try {
    const orgId = req.organizationId;

    const accessiblePipelines = await getAccessiblePipelineIds(req.user);
    const dealScope = isAdmin(req.user)
      ? { organization: orgId }
      : { organization: orgId, pipeline: { $in: accessiblePipelines } };

    // Stage-type filters used throughout. Built once, reused across all the
    // won/lost/active counters below so we don't refetch pipelines repeatedly.
    const stageOrs = await buildStageTypeOrs(orgId);

    const [contacts, activeDeals, tasks, wonDeals, lostDeals] = await Promise.all([
      Contact.countDocuments({ organization: orgId, isActive: true }),
      Deal.countDocuments(withStageType({ ...dealScope, isActive: true }, stageOrs, 'open')),
      Task.countDocuments({ organization: orgId, status: { $in: ['todo', 'in_progress'] } }),
      Deal.find(withStageType(dealScope, stageOrs, 'won')).select('value currency'),
      Deal.countDocuments(withStageType(dealScope, stageOrs, 'lost')),
    ]);

    const totalRevenue = wonDeals.reduce((sum, d) => sum + (d.value || 0), 0);

    const recentDeals = await Deal.find({ ...dealScope, isActive: true })
      .populate('contact', 'firstName lastName')
      .sort({ updatedAt: -1 })
      .limit(5);

    const upcomingTasks = await Task.find({
      organization: orgId,
      status: { $in: ['todo', 'in_progress'] },
    })
      .populate('assignedTo', 'name avatar')
      .sort({ dueDate: 1 })
      .limit(5);

    const pipelineStats = await Deal.aggregate([
      { $match: { ...dealScope, isActive: true } },
      { $group: { _id: '$stage', count: { $sum: 1 }, totalValue: { $sum: '$value' } } },
    ]);

    // Monthly chart — total/value comes from a simple aggregate; "won" comes
    // from a separate type-aware count and we merge by month-key.
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const monthlyTotals = await Deal.aggregate([
      { $match: { ...dealScope, createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          count: { $sum: 1 },
          value: { $sum: '$value' },
        },
      },
    ]);
    const monthlyWonRaw = await Deal.aggregate([
      { $match: withStageType({ ...dealScope, createdAt: { $gte: sixMonthsAgo } }, stageOrs, 'won') },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          won: { $sum: 1 },
        },
      },
    ]);
    const monthlyMap = new Map();
    for (const m of monthlyTotals) monthlyMap.set(m._id, { _id: m._id, count: m.count, value: m.value, won: 0 });
    for (const w of monthlyWonRaw) {
      const cur = monthlyMap.get(w._id) || { _id: w._id, count: 0, value: 0, won: 0 };
      cur.won = w.won;
      monthlyMap.set(w._id, cur);
    }
    const monthlyDeals = [...monthlyMap.values()].sort((a, b) => a._id.localeCompare(b._id));

    const totalDealsEver = await Deal.countDocuments(dealScope);
    const conversionRate = totalDealsEver > 0 ? Math.round((wonDeals.length / totalDealsEver) * 100) : 0;

    const Quote = (await import('../models/Quote.js')).default;
    const totalQuotes = await Quote.countDocuments({ organization: orgId });
    const viewedQuotes = await Quote.countDocuments({ organization: orgId, status: { $in: ['viewed', 'accepted'] } });

    const teamMembers = await User.find({ organization: orgId, isActive: true }).select('name avatar role');

    const teamPerformance = await Promise.all(teamMembers.map(async (member) => {
      const mid = member._id;
      const memberScope = { ...dealScope, assignedTo: mid };
      const [created, won, lost, quotesCreated, activeDealCount] = await Promise.all([
        Deal.countDocuments({ ...dealScope, $or: [{ createdBy: mid }, { assignedTo: mid }] }),
        Deal.countDocuments(withStageType(memberScope, stageOrs, 'won')),
        Deal.countDocuments(withStageType(memberScope, stageOrs, 'lost')),
        Quote.countDocuments({ organization: orgId, createdBy: mid }),
        Deal.countDocuments(withStageType({ ...memberScope, isActive: true }, stageOrs, 'open')),
      ]);

      const wonDealsForMember = await Deal.find(withStageType(memberScope, stageOrs, 'won'))
        .select('value createdAt wonAt');
      const revenue = wonDealsForMember.reduce((s, d) => s + (d.value || 0), 0);

      let avgCycleTime = 0;
      const dealsWithCycle = wonDealsForMember.filter(d => d.wonAt && d.createdAt);
      if (dealsWithCycle.length > 0) {
        const totalDays = dealsWithCycle.reduce((s, d) => {
          return s + Math.ceil((new Date(d.wonAt) - new Date(d.createdAt)) / (1000 * 60 * 60 * 24));
        }, 0);
        avgCycleTime = Math.round(totalDays / dealsWithCycle.length);
      }

      const convRate = (won + lost) > 0 ? Math.round((won / (won + lost)) * 100) : 0;

      return {
        _id: member._id,
        name: member.name,
        avatar: member.avatar,
        role: member.role,
        dealsCreated: created,
        dealsWon: won,
        dealsLost: lost,
        activeDeals: activeDealCount,
        quotesCreated,
        revenue,
        conversionRate: convRate,
        avgCycleTime,
      };
    }));

    res.json({
      contacts,
      activeDeals,
      pendingTasks: tasks,
      totalRevenue,
      // wonDeals/dealsWon/dealsLost — three keys for backwards compat. The
      // dashboard's win-rate calculation reads dealsWon/dealsLost.
      wonDeals: wonDeals.length,
      dealsWon: wonDeals.length,
      dealsLost: lostDeals,
      recentDeals,
      upcomingTasks,
      pipelineStats,
      monthlyDeals,
      conversionRate,
      totalQuotes,
      viewedQuotes,
      teamPerformance,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
