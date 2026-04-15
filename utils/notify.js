// Unified assignee/reminder notifier.
// Routes to WhatsApp when the org's plan allows it, falls back to email otherwise.
// Centralizing this here means callers don't repeat the plan-check + dual-template logic.

import { PLANS } from '../config/plans.js';
import { sendEmail } from './email.js';
import {
  notifyTaskAssigned,
  notifyTaskReminder,
  notifyDealAssigned,
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
    case 'record_inactive':
      return {
        subject: `Action needed: ${p.recordTitle}`,
        html: `<p>Hi ${p.userName},</p><p><strong>${p.recordTitle}</strong> has had no activity for ${p.daysAgo} days. Time to follow up?</p>`,
      };
    default:
      return null;
  }
}

function whatsappFor(type, p) {
  switch (type) {
    case 'task_assigned':   return notifyTaskAssigned(p);
    case 'task_reminder':   return notifyTaskReminder(p);
    case 'task_overdue':    return notifyTaskOverdue(p);
    case 'deal_assigned':   return notifyDealAssigned(p);
    case 'record_inactive': return notifyRecordInactive(p);
    default:                return Promise.resolve();
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
    return whatsappFor(type, { to: recipientPhone, ...merged });
  }
  if (recipientEmail) {
    const tpl = emailFor(type, merged);
    if (!tpl) return;
    return sendEmail({ to: recipientEmail, subject: tpl.subject, html: tpl.html });
  }
  console.warn(`[notify] no delivery channel for ${type} — user has no ${allowsWhatsapp ? 'phone or email' : 'email'}`);
}
