// Unified assignee/reminder notifier.
// Routes to WhatsApp when the org's plan allows it, falls back to email otherwise.
// Centralizing this here means callers don't repeat the plan-check + dual-template logic.

import { PLANS } from '../config/plans.js';
import { sendEmail } from './email.js';
import {
  notifyTaskAssigned,
  notifyTaskReminder,
  notifyDealAssigned,
  notifyDealWon,
  notifyRecordInactive,
  notifyTaskOverdue,
} from './whatsapp.js';

function fmtDateTime(d) {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
}

// Per-type email body. Kept inline (not a template module) — these are short and
// only sent when WhatsApp isn't available, so duplication isn't worth abstracting.
function emailFor(type, p) {
  switch (type) {
    case 'task_assigned':
      return {
        subject: `New task assigned: ${p.taskTitle}`,
        html: `<p>Hi ${p.userName},</p><p>You've been assigned a new task: <strong>${p.taskTitle}</strong>.</p>${p.dueDate ? `<p>Due: ${fmtDateTime(p.dueDate)}</p>` : ''}`,
      };
    case 'task_reminder':
      return {
        subject: `Reminder: ${p.taskTitle}`,
        html: `<p>Hi ${p.userName},</p><p>Your task <strong>${p.taskTitle}</strong> is due ${fmtDateTime(p.dueDate)}.</p>`,
      };
    case 'task_overdue':
      return {
        subject: `Overdue: ${p.taskTitle}`,
        html: `<p>Hi ${p.userName},</p><p>Your task <strong>${p.taskTitle}</strong> is overdue. Please update or close it.</p>`,
      };
    case 'deal_assigned':
      return {
        subject: `Deal assigned: ${p.dealTitle}`,
        html: `<p>Hi ${p.userName},</p><p>A new deal has been assigned to you: <strong>${p.dealTitle}</strong>.</p>`,
      };
    case 'deal_won':
      return {
        subject: `Deal won: ${p.dealTitle}`,
        html: `<p>Hi ${p.userName},</p><p>Good news — <strong>${p.dealTitle}</strong> has been marked as Won${p.byName ? ` by ${p.byName}` : ''}${p.role ? ` (${p.role})` : ''}.</p>${p.value ? `<p>Deal value: ${p.value}</p>` : ''}`,
      };
    case 'deal_unassigned':
      return {
        subject: `Deal reassigned: ${p.dealTitle}`,
        html: `<p>Hi ${p.userName},</p><p>The deal <strong>${p.dealTitle}</strong> has been reassigned${p.newAssigneeName ? ` to ${p.newAssigneeName}` : ''}. They are now the primary contact going forward.</p>`,
      };
    case 'record_inactive':
      return {
        subject: `Action needed: ${p.recordTitle}`,
        html: `<p>Hi ${p.userName},</p><p><strong>${p.recordTitle}</strong> has had no activity for ${p.daysAgo} days. Time to follow up?</p>`,
      };
    default:
      return null;
  }
}

// Returns a Promise for WhatsApp delivery, OR null if no template exists for this type.
// Returning null lets `notify()` fall through to email instead of silently dropping.
function whatsappFor(type, p) {
  switch (type) {
    case 'task_assigned':   return notifyTaskAssigned(p);
    case 'task_reminder':   return notifyTaskReminder(p);
    case 'task_overdue':    return notifyTaskOverdue(p);
    case 'deal_assigned':   return notifyDealAssigned(p);
    case 'deal_won':        return notifyDealWon(p);
    case 'record_inactive': return notifyRecordInactive(p);
    default:                return null;
  }
}

/**
 * Send a notification, choosing WhatsApp or email based on the org's plan.
 * Pass `plan` (the org's plan name) and a `user` with at least `name` plus one of `phone`/`email`.
 */
export async function notify({ plan, user, type, payload }) {
  if (!user) return;
  const allowsWhatsapp = !!PLANS[plan]?.whatsapp;
  const recipientPhone = user.phone;
  const recipientEmail = user.email;
  const merged = { ...payload, userName: user.name };

  if (allowsWhatsapp && recipientPhone) {
    const wa = whatsappFor(type, { to: recipientPhone, ...merged });
    if (wa) {
      try {
        return await wa;
      } catch (err) {
        // Common cause: the template isn't yet approved/registered in Meta
        // WhatsApp Manager. Don't drop the message — fall through to email.
        console.warn(`[notify] WhatsApp ${type} failed (${err.message}); falling back to email`);
      }
    }
  }
  if (recipientEmail) {
    const tpl = emailFor(type, merged);
    if (!tpl) return;
    return sendEmail({ to: recipientEmail, subject: tpl.subject, html: tpl.html });
  }
  console.warn(`[notify] no delivery channel for ${type} — user has no ${allowsWhatsapp ? 'phone or email' : 'email'}`);
}
