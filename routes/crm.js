import { Router } from 'express';
import Contact from '../models/Contact.js';
import { Deal, Pipeline } from '../models/Deal.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import Organization from '../models/Organization.js';
import { protect } from '../middleware/auth.js';
import { triggerAutomation } from '../automations/engine.js';
import { notify } from '../utils/notify.js';
import { requirePipelineQuota, requireTrialContactQuota } from '../middleware/partnerQuota.js';

const router = Router();

// ─── CONTACTS ────────────────────────────────────────

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

    const deals = await Deal.find({ contact: contact._id, organization: req.organizationId })
      .populate('pipeline', 'name')
      .sort({ createdAt: -1 });

    // Fetch tasks linked to this contact's deals
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

router.post('/contacts', protect, requireTrialContactQuota, async (req, res) => {
  try {
    const contact = await Contact.create({ ...req.body, organization: req.organizationId });
    triggerAutomation('contact.created', { organizationId: req.organizationId, contact, userId: req.user._id });
    res.status(201).json(contact);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/contacts/:id', protect, async (req, res) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true }
    );
    if (!contact) return res.status(404).json({ message: 'Not found' });
    res.json(contact);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/contacts/:id', protect, async (req, res) => {
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

router.get('/pipelines', protect, async (req, res) => {
  try {
    const pipelines = await Pipeline.find({ organization: req.organizationId, isActive: true });
    res.json({ pipelines });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/pipelines', protect, requirePipelineQuota, async (req, res) => {
  try {
    const pipeline = await Pipeline.create({ ...req.body, organization: req.organizationId });
    res.status(201).json(pipeline);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/pipelines/:id', protect, async (req, res) => {
  try {
    const pipeline = await Pipeline.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true }
    );
    if (!pipeline) return res.status(404).json({ message: 'Not found' });
    res.json(pipeline);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/pipelines/:id', protect, async (req, res) => {
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

router.get('/deals', protect, async (req, res) => {
  try {
    const { pipeline, stage, assignedTo, page = 1, limit = 100 } = req.query;
    const filter = { organization: req.organizationId, isActive: true };
    if (pipeline) filter.pipeline = pipeline;
    if (stage) filter.stage = stage;
    if (assignedTo) filter.assignedTo = assignedTo;

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

router.get('/deals/:id', protect, async (req, res) => {
  try {
    const deal = await Deal.findOne({ _id: req.params.id, organization: req.organizationId })
      .populate('contact')
      .populate('createdBy', 'name avatar')
      .populate('assignedTo', 'name avatar email')
      .populate('pipeline', 'name stages')
      .populate('quotes')
      .populate('notes.createdBy', 'name avatar');
    if (!deal) return res.status(404).json({ message: 'Deal not found' });

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

    res.json({ deal, tasks });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/deals', protect, async (req, res) => {
  try {
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

    // Fire automation
    triggerAutomation('deal.created', { organizationId: req.organizationId, deal, userId: req.user._id });

    // WhatsApp — notify assignee if they have a phone
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

router.put('/deals/:id', protect, async (req, res) => {
  try {
    const existing = await Deal.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!existing) return res.status(404).json({ message: 'Not found' });

    // Track stage changes
    if (req.body.stage && req.body.stage !== existing.stage) {
      existing.activities.push({
        type: 'stage_change',
        description: `${req.user.name} moved from "${existing.stage}" to "${req.body.stage}"`,
        createdBy: req.user._id,
      });

      // Record wonAt timestamp for performance tracking
      if (req.body.stage === 'Won' && !existing.wonAt) {
        req.body.wonAt = new Date();
      }
      if (req.body.stage === 'Lost' && !existing.lostAt) {
        req.body.lostAt = new Date();
      }

      triggerAutomation('deal.stage_changed', {
        organizationId: req.organizationId,
        deal: existing,
        userId: req.user._id,
        toStage: req.body.stage,
      });

      if (req.body.stage === 'Won') {
        triggerAutomation('deal.won', { organizationId: req.organizationId, deal: existing, userId: req.user._id });
      } else if (req.body.stage === 'Lost') {
        triggerAutomation('deal.lost', { organizationId: req.organizationId, deal: existing, userId: req.user._id });
      }
    }

    // Track assignment changes
    if (req.body.assignedTo && req.body.assignedTo.toString() !== existing.assignedTo?.toString()) {
      try {
        const newUser = await User.findById(req.body.assignedTo).select('name phone');
        const oldUser = existing.assignedTo ? await User.findById(existing.assignedTo).select('name') : null;
        existing.activities.push({
          type: 'assignment_change',
          description: `${req.user.name} reassigned from ${oldUser?.name || 'unassigned'} to ${newUser?.name || 'unknown'}`,
          createdBy: req.user._id,
        });
        // WhatsApp — notify the newly assigned user
        if (newUser) {
          notify({
            plan: req.organization?.plan,
            user: newUser,
            type: 'deal_assigned',
            payload: { dealTitle: existing.title },
          }).catch(err => console.error('[notify] deal_assigned (reassign) failed:', err.message));
        }
      } catch (err) { /* silent */ }
    }

    Object.assign(existing, req.body);
    await existing.save();

    const populated = await Deal.findById(existing._id)
      .populate('contact', 'firstName lastName email')
      .populate('assignedTo', 'name avatar')
      .populate('pipeline', 'name stages');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/deals/:id', protect, async (req, res) => {
  try {
    await Deal.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { isActive: false }
    );
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add activity to deal
router.post('/deals/:id/activities', protect, async (req, res) => {
  try {
    const deal = await Deal.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!deal) return res.status(404).json({ message: 'Not found' });

    deal.activities.push({ ...req.body, createdBy: req.user._id });
    await deal.save();
    res.json(deal);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add note to deal
router.post('/deals/:id/notes', protect, async (req, res) => {
  try {
    const deal = await Deal.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!deal) return res.status(404).json({ message: 'Not found' });

    // Migrate old string notes to array if needed
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

// Delete note
router.delete('/deals/:id/notes/:noteId', protect, async (req, res) => {
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

// Pin/unpin note
router.put('/deals/:id/notes/:noteId', protect, async (req, res) => {
  try {
    const deal = await Deal.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!deal) return res.status(404).json({ message: 'Not found' });

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

router.get('/tasks', protect, async (req, res) => {
  try {
    const { status, assignedTo, deal } = req.query;
    const filter = { organization: req.organizationId };
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (deal) filter.deal = deal;

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

router.post('/tasks', protect, async (req, res) => {
  try {
    const task = await Task.create({
      ...req.body,
      organization: req.organizationId,
      createdBy: req.user._id,
    });
    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name avatar')
      .populate('deal', 'title');

    // Fire automation if assigned
    if (task.assignedTo) {
      triggerAutomation('task.assigned', { organizationId: req.organizationId, task, userId: req.user._id });

      // WhatsApp — notify assignee if they have a phone
      User.findById(task.assignedTo).select('name phone').lean()
        .then(assignee => notify({
          plan: req.organization?.plan,
          user: assignee,
          type: 'task_assigned',
          payload: { taskTitle: task.title, dueDate: task.dueDate },
        }))
        .catch(err => console.error('[notify] task_assigned failed:', err.message));
    }

    // Task reminder fires automatically via the poller — reminderSentAt defaults to null.

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/tasks/:id', protect, async (req, res) => {
  try {
    if (req.body.status === 'done') req.body.completedAt = new Date();
    const prior = await Task.findOne({ _id: req.params.id, organization: req.organizationId })
      .select('assignedTo dueDate reminderHours').lean();

    const dueDateChanged = 'dueDate' in req.body &&
      new Date(req.body.dueDate || 0).getTime() !== new Date(prior?.dueDate || 0).getTime();
    const reminderHoursChanged = 'reminderHours' in req.body &&
      req.body.reminderHours !== prior?.reminderHours;
    if (dueDateChanged || reminderHoursChanged) {
      req.body.reminderSentAt = null;
    }

    const task = await Task.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true }
    ).populate('assignedTo', 'name avatar');
    if (!task) return res.status(404).json({ message: 'Not found' });

    const newAssignee = task.assignedTo?._id || task.assignedTo;
    const priorAssignee = prior?.assignedTo;
    if (newAssignee && String(newAssignee) !== String(priorAssignee || '')) {
      triggerAutomation('task.assigned', { organizationId: req.organizationId, task, userId: req.user._id });
    }

    res.json(task);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/tasks/:id', protect, async (req, res) => {
  try {
    await Task.findOneAndDelete({ _id: req.params.id, organization: req.organizationId });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── DASHBOARD STATS ────────────────────────────────

router.get('/stats', protect, async (req, res) => {
  try {
    const orgId = req.organizationId;
    const [contacts, activeDeals, tasks, wonDeals] = await Promise.all([
      Contact.countDocuments({ organization: orgId, isActive: true }),
      Deal.countDocuments({ organization: orgId, isActive: true, stage: { $nin: ['Won', 'Lost'] } }),
      Task.countDocuments({ organization: orgId, status: { $in: ['todo', 'in_progress'] } }),
      Deal.find({ organization: orgId, stage: 'Won' }).select('value currency'),
    ]);

    const totalRevenue = wonDeals.reduce((sum, d) => sum + (d.value || 0), 0);

    const recentDeals = await Deal.find({ organization: orgId, isActive: true })
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

    // Pipeline breakdown
    const pipelineStats = await Deal.aggregate([
      { $match: { organization: orgId, isActive: true } },
      { $group: { _id: '$stage', count: { $sum: 1 }, totalValue: { $sum: '$value' } } },
    ]);

    // Monthly deals (last 6 months) for chart
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const monthlyDeals = await Deal.aggregate([
      { $match: { organization: orgId, createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          count: { $sum: 1 },
          value: { $sum: '$value' },
          won: { $sum: { $cond: [{ $eq: ['$stage', 'Won'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Conversion rate
    const totalDealsEver = await Deal.countDocuments({ organization: orgId });
    const conversionRate = totalDealsEver > 0 ? Math.round((wonDeals.length / totalDealsEver) * 100) : 0;

    // Quotes stats
    const Quote = (await import('../models/Quote.js')).default;
    const totalQuotes = await Quote.countDocuments({ organization: orgId });
    const viewedQuotes = await Quote.countDocuments({ organization: orgId, status: { $in: ['viewed', 'accepted'] } });

    // Team performance — per member stats
    const User = (await import('../models/User.js')).default;
    const teamMembers = await User.find({ organization: orgId, isActive: true }).select('name avatar role');

    const teamPerformance = await Promise.all(teamMembers.map(async (member) => {
      const mid = member._id;
      const [created, won, lost, quotesCreated, activeDealCount] = await Promise.all([
        Deal.countDocuments({ organization: orgId, $or: [{ createdBy: mid }, { assignedTo: mid }] }),
        Deal.countDocuments({ organization: orgId, assignedTo: mid, stage: 'Won' }),
        Deal.countDocuments({ organization: orgId, assignedTo: mid, stage: 'Lost' }),
        Quote.countDocuments({ organization: orgId, createdBy: mid }),
        Deal.countDocuments({ organization: orgId, assignedTo: mid, isActive: true, stage: { $nin: ['Won', 'Lost'] } }),
      ]);

      // Revenue closed
      const wonDealsForMember = await Deal.find({ organization: orgId, assignedTo: mid, stage: 'Won' }).select('value createdAt wonAt');
      const revenue = wonDealsForMember.reduce((s, d) => s + (d.value || 0), 0);

      // Average cycle time (created → won) in days
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
      wonDeals: wonDeals.length,
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