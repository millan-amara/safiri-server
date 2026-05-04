// Reusable email templates for operator-to-client and operator-to-supplier
// communication. Each template returns { subject, body, defaultRecipient }.
// Operator can edit subject/body in the modal before sending — these are
// just sensible starting points.
//
// Variable substitution uses {{var}} syntax. Unknown variables stay literal
// so it's obvious in the preview when a template is missing context.

const TEMPLATES = {
  pre_arrival_checklist: {
    label: 'Pre-arrival checklist',
    description: 'T-7 days reminder to client — documents, packing, contact details.',
    audience: 'client',
    subject: 'Your trip to {{destination}} starts {{startDate}} — quick checklist',
    body: `Hi {{firstName}},

Your trip to {{destination}} is just around the corner — {{daysUntilTrip}} days to go!

A few things to make sure of before you fly:

• Travel documents — passport valid 6+ months past your return date, plus any required visas
• Travel insurance — strongly recommended; should cover medical and trip cancellation
• Vaccinations — check that you're current on what's recommended for {{destination}}
• Packing — light layers (mornings cold, days hot), modest clothing for cultural sites, sturdy shoes
• Money — small USD bills for tips ($5–$20 each), credit card as backup
• Arrival flight — please reply with your final flight details so we can coordinate the airport pickup

If anything has changed (dates, dietary needs, special requests), let me know now so we can update the lodges in time.

Looking forward to a great trip!

{{operatorName}}
{{orgName}}`,
  },

  request_lodge_confirmation: {
    label: 'Request lodge confirmation',
    description: 'To a hotel/lodge — asks them to confirm a reservation. Attach the voucher.',
    audience: 'lodge',
    subject: 'Booking confirmation request — {{clientName}}, {{startDate}}',
    body: `Hi team,

Please confirm the following reservation at your earliest convenience:

  Guest:        {{clientName}}
  Trip dates:   {{startDate}} → {{endDate}}
  Adults:       {{adults}}
  Children:     {{children}}
  Trip ref:     {{tripTitle}}

Could you reply with your confirmation number for our records?

Many thanks,
{{operatorName}}
{{orgName}}`,
  },

  post_trip_thanks: {
    label: 'Post-trip thank you',
    description: 'Sent after the client returns — thanks them and asks for a review.',
    audience: 'client',
    subject: 'Welcome home — thank you from {{orgName}}',
    body: `Hi {{firstName}},

We hope your time in {{destination}} was everything you were hoping for. It was a real pleasure putting your trip together.

A few small asks before we sign off:

• If you'd consider sharing a brief review (Google / TripAdvisor / Facebook), it genuinely helps us reach travelers like you.
• If you have feedback — good, bad, anything in between — please reply to this email. We read every word and use it to get better.
• If you're already thinking about your next adventure, we'd love to plan it with you.

Thanks again for choosing us.

{{operatorName}}
{{orgName}}`,
  },

  quote_followup: {
    label: 'Quote follow-up',
    description: 'Nudges a client who hasn\'t responded to a sent quote.',
    audience: 'client',
    subject: 'Following up on your {{destination}} itinerary',
    body: `Hi {{firstName}},

Just checking in on the {{destination}} itinerary I sent over — wanted to see if you've had a chance to review it, or if anything came up that we should chat through.

Happy to:

• Adjust dates, lodges, or activities to better match what you're after
• Send a revised version with a different price point
• Hop on a quick call if that's easier

Reply with what works — or if it's a "not now," that's fine too, just let me know so I'm not chasing.

{{operatorName}}
{{orgName}}`,
  },

  custom: {
    label: 'Custom email',
    description: 'Blank — write your own.',
    audience: 'client',
    subject: '',
    body: '',
  },
};

// Build the variable bag from a deal + contact + org + sender. Date/number
// formatting happens here so the template body is plain string substitution.
export function buildTemplateContext({ deal, contact, org, user }) {
  const formatDate = (d) => d
    ? new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  let daysUntilTrip = '';
  if (deal?.travelDates?.start) {
    const ms = new Date(deal.travelDates.start).getTime() - Date.now();
    const days = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
    daysUntilTrip = String(days);
  }

  const firstName = contact?.firstName || '';
  const lastName = contact?.lastName || '';
  const clientName = `${firstName} ${lastName}`.trim() || 'there';

  return {
    firstName: firstName || 'there',
    lastName,
    clientName,
    tripTitle: deal?.title || '',
    destination: deal?.destination || 'your destination',
    startDate: formatDate(deal?.travelDates?.start),
    endDate: formatDate(deal?.travelDates?.end),
    daysUntilTrip,
    adults: String(deal?.groupSize || ''),
    children: '0',
    operatorName: user?.name || '',
    orgName: org?.name || '',
  };
}

function interpolate(str, ctx) {
  return String(str || '').replace(/\{\{(\w+)\}\}/g, (m, key) => (
    ctx[key] !== undefined && ctx[key] !== '' ? ctx[key] : m
  ));
}

// Render a template by key. Returns null for an unknown key so the caller
// can decide how to surface that (4xx vs throw).
export function renderTemplate(key, ctx) {
  const tpl = TEMPLATES[key];
  if (!tpl) return null;
  return {
    key,
    label: tpl.label,
    audience: tpl.audience,
    subject: interpolate(tpl.subject, ctx),
    body: interpolate(tpl.body, ctx),
  };
}

// Return the metadata list (no body) for the client picker.
export function listTemplates() {
  return Object.entries(TEMPLATES).map(([key, t]) => ({
    key,
    label: t.label,
    description: t.description,
    audience: t.audience,
  }));
}

// Plain-text → simple HTML for the email body. Keeps line breaks and bullet
// glyphs readable. Operator's edits in the modal go through here so what
// they see (textarea) maps directly to what the recipient sees.
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export function bodyToHtml(body) {
  return escapeHtml(body)
    .split('\n')
    .map(line => line.length === 0 ? '<br/>' : `<p style="margin: 0 0 12px;">${line}</p>`)
    .join('');
}
