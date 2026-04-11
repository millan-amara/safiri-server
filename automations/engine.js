import Automation from '../models/Automation.js';
import Task from '../models/Task.js';
import Contact from '../models/Contact.js';
import { Deal, Pipeline } from '../models/Deal.js';
import User from '../models/User.js';
import { createNotification } from '../routes/notifications.js';
import { sendEmail } from '../utils/email.js';

// Replace {{contact.firstName}}, {{deal.title}} etc.
function interpolate(template, context) {
  if (!template) return '';
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
    const parts = path.split('.');
    let value = context;
    for (const key of parts) {
      value = value?.[key];
      if (value === undefined) return match;
    }
    return String(value);
  });
}

// Check if conditions pass
function checkConditions(conditions, context) {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((cond) => {
    const parts = cond.field.split('.');
    let value = context;
    for (const key of parts) {
      value = value?.[key];
    }
    switch (cond.operator) {
      case 'equals': return String(value) === String(cond.value);
      case 'not_equals': return String(value) !== String(cond.value);
      case 'contains':
        if (Array.isArray(value)) return value.includes(cond.value);
        return String(value || '').toLowerCase().includes(String(cond.value).toLowerCase());
      case 'greater_than': return parseFloat(value) > parseFloat(cond.value);
      case 'less_than': return parseFloat(value) < parseFloat(cond.value);
      case 'exists': return value !== undefined && value !== null && value !== '';
      default: return true;
    }
  });
}

// Resolve who to assign to
function resolveAssignee(assignTo, context) {
  if (assignTo === 'same_as_deal') return context.deal?.assignedTo?._id || context.deal?.assignedTo;
  if (assignTo === 'same_as_contact') return context.contact?.assignedTo?._id || context.contact?.assignedTo;
  return assignTo; // direct userId
}

// Execute a single action
async function executeAction(action, context, organizationId) {
  const { type, config } = action;

  try {
    switch (type) {
      case 'send_email': {
        const to = config.to === 'contact' ? context.contact?.email
          : config.to === 'assigned_user' ? context.assignedUserEmail
          : config.to;
        if (!to) return { success: false, error: 'No email recipient' };

        await sendEmail({
          to,
          subject: interpolate(config.subject, context),
          html: interpolate(config.body, context),
        });
        return { success: true, action: 'send_email', to };
      }

      case 'send_notification': {
        let targetUserId;
        if (config.targetUser === 'assigned_user') targetUserId = context.deal?.assignedTo?._id || context.deal?.assignedTo;
        else if (config.targetUser === 'creator') targetUserId = context.deal?.createdBy?._id || context.deal?.createdBy;
        else targetUserId = config.targetUser;

        if (targetUserId) {
          await createNotification({
            organization: organizationId,
            user: targetUserId,
            type: 'system',
            title: interpolate(config.message, context),
            message: context.deal?.title || context.contact?.firstName || '',
            entityType: context.deal ? 'deal' : context.contact ? 'contact' : null,
            entityId: context.deal?._id || context.contact?._id || null,
          });
        }
        return { success: true, action: 'send_notification' };
      }

      case 'send_webhook': {
        if (!config.url) return { success: false, error: 'No webhook URL' };
        const payload = config.payload === 'full_context'
          ? { trigger: context.triggerType, contact: context.contact, deal: context.deal, task: context.task, timestamp: new Date().toISOString() }
          : config.payload || {};

        await fetch(config.url, {
          method: config.method || 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return { success: true, action: 'send_webhook' };
      }

      case 'create_task': {
        const assignTo = resolveAssignee(config.assignTo, context);
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + (config.taskDueDays || 1));

        await Task.create({
          organization: organizationId,
          title: interpolate(config.taskTitle, context),
          priority: config.taskPriority || 'medium',
          assignedTo: assignTo || null,
          deal: context.deal?._id || null,
          contact: context.contact?._id || null,
          dueDate,
          status: 'todo',
        });
        return { success: true, action: 'create_task' };
      }

      case 'create_deal': {
        if (!context.contact?._id) return { success: false, error: 'No contact' };

        let pipeline;
        if (config.pipelineId) {
          pipeline = await Pipeline.findById(config.pipelineId);
        } else {
          pipeline = await Pipeline.findOne({ organization: organizationId, isDefault: true });
        }
        if (!pipeline) return { success: false, error: 'No pipeline found' };

        const stage = config.stageId
          ? pipeline.stages.find(s => s._id.toString() === config.stageId || s.name === config.stageId)
          : pipeline.stages.sort((a, b) => a.order - b.order)[0];

        const assignTo = resolveAssignee(config.assignDealTo, context);

        await Deal.create({
          organization: organizationId,
          title: interpolate(config.dealTitle || 'New deal: {{contact.firstName}} {{contact.lastName}}', context),
          contact: context.contact._id,
          pipeline: pipeline._id,
          stage: stage?.name || 'New Inquiry',
          assignedTo: assignTo || null,
          createdBy: context.userId || null,
          activities: [{ type: 'deal_created', description: 'Auto-created by automation', createdAt: new Date() }],
        });
        return { success: true, action: 'create_deal' };
      }

      case 'assign_to_user': {
        if (!config.userId) return { success: false, error: 'No userId' };
        if (context.deal?._id) await Deal.findByIdAndUpdate(context.deal._id, { assignedTo: config.userId });
        if (context.contact?._id) await Contact.findByIdAndUpdate(context.contact._id, { assignedTo: config.userId });
        return { success: true, action: 'assign_to_user' };
      }

      case 'add_tag': {
        if (context.contact?._id && config.tag) {
          await Contact.findByIdAndUpdate(context.contact._id, { $addToSet: { tags: config.tag } });
        }
        return { success: true, action: 'add_tag' };
      }

      default:
        return { success: false, error: `Unknown action: ${type}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── MAIN TRIGGER FUNCTION ──────────────────────────────

export async function triggerAutomation(triggerType, eventData) {
  try {
    const { organizationId, deal, contact, task, userId, toStage } = eventData;

    const automations = await Automation.find({
      organization: organizationId,
      isActive: true,
      'trigger.type': triggerType,
    }).lean();

    if (automations.length === 0) return;

    // Populate for context
    let populatedDeal = deal ? (deal.toObject ? deal.toObject() : deal) : null;
    let populatedContact = contact ? (contact.toObject ? contact.toObject() : contact) : null;

    if (deal?._id) {
      const fetched = await Deal.findById(deal._id)
        .populate('assignedTo', 'name email')
        .populate('contact', 'firstName lastName email phone')
        .lean();
      if (fetched) populatedDeal = fetched;
    }

    if (contact?._id) {
      const fetched = await Contact.findById(contact._id)
        .populate('assignedTo', 'name email')
        .lean();
      if (fetched) populatedContact = fetched;
    }

    // Get assigned user email for send_email actions
    let assignedUserEmail = null;
    const assignedUserId = populatedDeal?.assignedTo?._id || populatedDeal?.assignedTo || populatedContact?.assignedTo?._id || populatedContact?.assignedTo;
    if (assignedUserId) {
      const assignedUser = populatedDeal?.assignedTo?.email ? populatedDeal.assignedTo : await User.findById(assignedUserId).select('email name').lean();
      assignedUserEmail = assignedUser?.email;
    }

    const context = {
      triggerType,
      deal: populatedDeal,
      contact: populatedContact || populatedDeal?.contact || null,
      task: task ? (task.toObject ? task.toObject() : task) : null,
      assignedUserEmail,
      userId,
    };

    for (const automation of automations) {
      try {
        // Stage filter check
        if (triggerType === 'deal.stage_changed' && automation.trigger.config?.toStage) {
          if (toStage !== automation.trigger.config.toStage) continue;
        }

        // Conditions check
        if (!checkConditions(automation.conditions, context)) continue;

        // Execute actions
        const results = [];
        for (const action of automation.actions) {
          const result = await executeAction(action, context, organizationId);
          results.push(result);
          if (!result.success) {
            console.error(`Automation "${automation.name}" action ${action.type} failed:`, result.error);
          }
        }

        // Update stats
        await Automation.findByIdAndUpdate(automation._id, {
          $inc: { runCount: 1 },
          $set: {
            lastRunAt: new Date(),
            lastRunStatus: results.every(r => r.success) ? 'success' : results.some(r => r.success) ? 'partial' : 'failed',
          },
        });

      } catch (err) {
        console.error(`Automation "${automation.name}" failed:`, err.message);
        await Automation.findByIdAndUpdate(automation._id, {
          $set: { lastRunStatus: 'failed', lastRunAt: new Date() },
        });
      }
    }
  } catch (err) {
    console.error('triggerAutomation error:', err.message);
  }
}

// ─── SCHEDULED CHECKS (run on interval, no Redis needed) ─────

export async function checkInactiveDeals() {
  try {
    const orgs = await Automation.distinct('organization', { isActive: true, 'trigger.type': 'deal.inactive' });

    for (const orgId of orgs) {
      const automations = await Automation.find({ organization: orgId, isActive: true, 'trigger.type': 'deal.inactive' }).lean();

      for (const auto of automations) {
        const days = auto.trigger.config?.inactiveDays || 3;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        const inactiveDeals = await Deal.find({
          organization: orgId,
          isActive: true,
          stage: { $nin: ['Won', 'Lost'] },
          updatedAt: { $lt: cutoff },
        }).populate('assignedTo', 'name email').populate('contact', 'firstName lastName email');

        for (const deal of inactiveDeals) {
          await triggerAutomation('deal.inactive', { organizationId: orgId, deal });
        }
      }
    }
  } catch (err) {
    console.error('checkInactiveDeals error:', err.message);
  }
}

export async function checkOverdueTasks() {
  try {
    const orgs = await Automation.distinct('organization', { isActive: true, 'trigger.type': 'task.overdue' });

    for (const orgId of orgs) {
      const overdueTasks = await Task.find({
        organization: orgId,
        status: { $in: ['todo', 'in_progress'] },
        dueDate: { $lt: new Date() },
      }).populate('assignedTo', 'name email').populate('deal', 'title');

      for (const task of overdueTasks) {
        await triggerAutomation('task.overdue', { organizationId: orgId, task });
      }
    }
  } catch (err) {
    console.error('checkOverdueTasks error:', err.message);
  }
}