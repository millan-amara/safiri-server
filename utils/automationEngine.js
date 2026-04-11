import Automation from '../models/Automation.js';
import Task from '../models/Task.js';
import { createNotification } from '../routes/notifications.js';

/**
 * Automation Engine
 * 
 * Call triggerAutomation(orgId, eventType, context) from any route
 * to fire matching automations.
 * 
 * Supported triggers:
 *   deal_created, deal_stage_changed, task_assigned, 
 *   task_overdue, quote_viewed, quote_sent, contact_created
 * 
 * Supported actions:
 *   send_notification, create_task, call_webhook
 */

export async function triggerAutomation(organizationId, eventType, context = {}) {
  try {
    const automations = await Automation.find({
      organization: organizationId,
      isActive: true,
      'trigger.type': eventType,
    });

    for (const auto of automations) {
      // Check conditions
      if (!matchesConditions(auto.trigger.conditions, context)) continue;

      // Execute each action
      for (const action of auto.actions) {
        try {
          await executeAction(action, context, organizationId);
        } catch (err) {
          console.error(`Automation "${auto.name}" action failed:`, err.message);
        }
      }

      // Update stats
      auto.runCount += 1;
      auto.lastRunAt = new Date();
      await auto.save();
    }
  } catch (err) {
    console.error('Automation engine error:', err.message);
  }
}

function matchesConditions(conditions, context) {
  if (!conditions || Object.keys(conditions).length === 0) return true;

  for (const [key, value] of Object.entries(conditions)) {
    if (key === 'stage' && context.stage !== value) return false;
    if (key === 'priority' && context.priority !== value) return false;
  }
  return true;
}

async function executeAction(action, context, organizationId) {
  switch (action.type) {
    case 'send_notification': {
      const message = interpolate(action.config?.message || '', context);
      const targetUser = context.assignedTo || context.createdBy || context.userId;
      if (targetUser) {
        await createNotification({
          organization: organizationId,
          user: targetUser,
          type: context.eventType || 'system',
          title: message,
          message: context.dealTitle || context.taskTitle || '',
          entityType: context.entityType || null,
          entityId: context.entityId || null,
        });
      }
      break;
    }

    case 'create_task': {
      const title = interpolate(action.config?.title || 'Follow up', context);
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (action.config?.dueInDays || 3));

      await Task.create({
        organization: organizationId,
        title,
        deal: context.dealId || null,
        contact: context.contactId || null,
        assignedTo: context.assignedTo || context.createdBy || null,
        createdBy: context.createdBy || null,
        dueDate,
        priority: action.config?.priority || 'medium',
        status: 'todo',
      });
      break;
    }

    case 'call_webhook': {
      const Organization = (await import('../models/Organization.js')).default;
      const org = await Organization.findById(organizationId);
      const webhookUrl = action.config?.url || org?.webhookUrl;

      if (webhookUrl) {
        try {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: context.eventType,
              timestamp: new Date().toISOString(),
              data: context,
            }),
          });
        } catch (err) {
          console.error('Webhook call failed:', err.message);
        }
      }
      break;
    }

    default:
      console.warn(`Unknown action type: ${action.type}`);
  }
}

function interpolate(template, context) {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
    const keys = path.split('.');
    let value = context;
    for (const key of keys) {
      value = value?.[key];
      if (value === undefined) return match;
    }
    return String(value);
  });
}