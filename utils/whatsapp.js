const BASE_URL = 'https://graph.facebook.com/v19.0';

// Strip everything non-numeric, return null if invalid
function formatPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits;
}

function formatDate(date) {
  const d = new Date(date);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function formatTime(date) {
  const d = new Date(date);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

// ─── CORE SEND ───────────────────────────────────────────

export async function sendWhatsAppTemplate(to, templateName, params) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.warn(`[WhatsApp] Not configured — skipping "${templateName}" to ${to}`);
    return;
  }

  const phone = formatPhone(to);
  if (!phone) {
    console.warn(`[WhatsApp] Invalid phone number: ${to}`);
    return;
  }

  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en' },
      components: [{
        type: 'body',
        parameters: params.map(text => ({ type: 'text', text: String(text) })),
      }],
    },
  };

  const res = await fetch(`${BASE_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`WhatsApp API ${res.status}: ${err?.error?.message || res.statusText}`);
  }

  return res.json();
}

// ─── TEMPLATE HELPERS ────────────────────────────────────

// task_assigned: Hi {{1}}, you have been assigned a new task: {{2}}. Due {{3}} at {{4}}.
export function notifyTaskAssigned({ to, userName, taskTitle, dueDate }) {
  return sendWhatsAppTemplate(to, 'task_assigned', [
    userName,
    taskTitle,
    dueDate ? formatDate(dueDate) : 'TBD',
    dueDate ? formatTime(dueDate) : 'TBD',
  ]);
}

// task_reminder: Hi {{1}}, your task {{2}} is due on {{3}} at {{4}}.
export function notifyTaskReminder({ to, userName, taskTitle, dueDate }) {
  return sendWhatsAppTemplate(to, 'task_reminder', [
    userName,
    taskTitle,
    dueDate ? formatDate(dueDate) : 'TBD',
    dueDate ? formatTime(dueDate) : 'TBD',
  ]);
}

// client_assigned: Hi {{1}}, a new deal has been assigned to you: {{2}}.
export function notifyDealAssigned({ to, userName, dealTitle }) {
  return sendWhatsAppTemplate(to, 'client_assigned', [
    userName,
    dealTitle,
  ]);
}

// record_inactive: Hi {{1}}, action required on {{2}}. Last activity: {{3}} days ago.
export function notifyRecordInactive({ to, userName, recordTitle, daysAgo }) {
  return sendWhatsAppTemplate(to, 'record_inactive', [
    userName,
    recordTitle,
    String(daysAgo),
  ]);
}

// task_overdue: Hi {{1}}, your task {{2}} was due on {{3}} and is now overdue. Please action this as soon as possible.
export function notifyTaskOverdue({ to, userName, taskTitle, dueDate }) {
  return sendWhatsAppTemplate(to, 'task_overdue', [
    userName,
    taskTitle,
    dueDate ? formatDate(dueDate) : 'TBD',
  ]);
}

// client_won: Hi {{1}}, the client {{2}} has been marked as Won by {{3}}.
// {{3}} folds the closer's name + optional role (e.g. "Mike (original creator)")
// because WhatsApp rejects empty template parameters.
// NOTE: This template must be created + approved in Meta WhatsApp Manager
// before delivery will succeed. Until then notify() will fall back to email.
export function notifyDealWon({ to, userName, dealTitle, byName, role }) {
  const closerName = byName || 'a teammate';
  const closer = role ? `${closerName} (${role})` : closerName;
  return sendWhatsAppTemplate(to, 'client_won', [
    userName,
    dealTitle,
    closer,
  ]);
}
