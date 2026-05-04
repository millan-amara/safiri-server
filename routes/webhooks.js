import { Router } from 'express';
import Organization from '../models/Organization.js';
import Contact from '../models/Contact.js';
import { Deal, Pipeline } from '../models/Deal.js';
import { triggerAutomation } from '../automations/engine.js';

const router = Router();

// API key auth middleware
async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing x-api-key header' });

  const org = await Organization.findOne({ apiKey });
  if (!org) return res.status(401).json({ error: 'Invalid API key' });

  req.organizationId = org._id;
  req.organization = org;
  next();
}

router.use(apiKeyAuth);

// GET /api/webhooks/contacts
router.get('/contacts', async (req, res) => {
  try {
    const { limit = 50, offset = 0, email } = req.query;
    const filter = { organization: req.organizationId, isActive: true };
    if (email) filter.email = email.toLowerCase();
    const contacts = await Contact.find(filter).sort({ createdAt: -1 }).skip(parseInt(offset)).limit(parseInt(limit)).select('-__v');
    const total = await Contact.countDocuments(filter);
    res.json({ contacts, total });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/webhooks/contacts — create or upsert
router.post('/contacts', async (req, res) => {
  try {
    const { email, firstName, lastName, phone, company, country, source, tags } = req.body;
    if (!email && !phone) return res.status(400).json({ error: 'email or phone required' });

    let contact = email ? await Contact.findOne({ email: email.toLowerCase(), organization: req.organizationId }) : null;

    if (contact) {
      if (firstName) contact.firstName = firstName;
      if (lastName) contact.lastName = lastName;
      if (phone) contact.phone = phone;
      if (company) contact.company = company;
      if (country) contact.country = country;
      if (tags && Array.isArray(tags)) contact.tags = [...new Set([...contact.tags, ...tags])];
      await contact.save();
      res.json({ contact, action: 'updated' });
    } else {
      contact = await Contact.create({
        organization: req.organizationId,
        firstName: firstName || '', lastName: lastName || '',
        email: email?.toLowerCase() || '', phone: phone || '',
        company: company || '', country: country || '',
        source: source || 'api', tags: tags || [],
      });
      triggerAutomation('contact.created', { organizationId: req.organizationId, contact });
      res.status(201).json({ contact, action: 'created' });
    }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// PUT /api/webhooks/contacts/:id
const ALLOWED_CONTACT_FIELDS = ['firstName', 'lastName', 'phone', 'company', 'country', 'source', 'tags', 'notes'];
router.put('/contacts/:id', async (req, res) => {
  try {
    // Whitelist editable fields — never spread req.body into $set, since that
    // lets the caller overwrite organization, _id, isActive, etc.
    const update = {};
    for (const k of ALLOWED_CONTACT_FIELDS) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { $set: update },
      { new: true }
    );
    if (!contact) return res.status(404).json({ error: 'Not found' });
    res.json({ contact });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/webhooks/deals
router.get('/deals', async (req, res) => {
  try {
    const { limit = 50, offset = 0, stage } = req.query;
    const filter = { organization: req.organizationId, isActive: true };
    if (stage) filter.stage = stage;
    const deals = await Deal.find(filter).populate('contact', 'firstName lastName email').sort({ createdAt: -1 }).skip(parseInt(offset)).limit(parseInt(limit)).select('-__v');
    const total = await Deal.countDocuments(filter);
    res.json({ deals, total });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/webhooks/deals
router.post('/deals', async (req, res) => {
  try {
    const { title, contactId, contactEmail, stage, destination, groupSize, budget, value } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    // Resolve a contact reference. The contactId path verifies the contact
    // belongs to the caller's org so a leaked/abused API key can't attach a
    // foreign-tenant contact to a new deal.
    let contactRef;
    if (contactId) {
      const owned = await Contact.findOne({ _id: contactId, organization: req.organizationId }).select('_id');
      if (!owned) return res.status(400).json({ error: 'contactId not found in your organization' });
      contactRef = owned._id;
    } else if (contactEmail) {
      const c = await Contact.findOne({ email: contactEmail.toLowerCase(), organization: req.organizationId });
      if (c) contactRef = c._id;
    }

    const pipeline = await Pipeline.findOne({ organization: req.organizationId, isDefault: true });
    if (!pipeline) return res.status(400).json({ error: 'No pipeline configured' });
    const firstStage = pipeline.stages.sort((a, b) => a.order - b.order)[0];

    // Validate the requested stage actually exists in the org's pipeline —
    // otherwise the caller can stuff arbitrary stage strings into the deal.
    let resolvedStage = firstStage?.name || 'New Inquiry';
    if (stage) {
      const match = pipeline.stages.find(s => s.name === stage);
      if (match) resolvedStage = match.name;
    }

    const deal = await Deal.create({
      organization: req.organizationId, title,
      contact: contactRef || undefined, pipeline: pipeline._id,
      stage: resolvedStage,
      destination: destination || '', groupSize: groupSize || 0,
      budget: budget || 0, value: value || 0,
      activities: [{ type: 'deal_created', description: 'Created via API', createdAt: new Date() }],
    });
    triggerAutomation('deal.created', { organizationId: req.organizationId, deal });
    res.status(201).json({ deal });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/webhooks/events — fire automation trigger
// Allowlist of events callers may trigger via API. Internal-only events
// (e.g. quote.viewed, deal.won — which the system fires itself) are excluded
// so an API caller can't synthesize state changes they don't actually own.
const PUBLIC_EVENTS = new Set([
  'contact.created',
  'contact.updated',
  'deal.created',
  'deal.updated',
]);
router.post('/events', async (req, res) => {
  try {
    const { event, contactId, dealId, data } = req.body;
    if (!event) return res.status(400).json({ error: 'event type required' });
    if (!PUBLIC_EVENTS.has(event)) {
      return res.status(400).json({ error: `event "${event}" is not allowed via API` });
    }
    // Don't spread caller-supplied data on top of organizationId — let the
    // caller add metadata under a `data` key but never override scope fields.
    const eventData = { organizationId: req.organizationId, data: data || {} };
    if (contactId) {
      const c = await Contact.findOne({ _id: contactId, organization: req.organizationId });
      if (!c) return res.status(400).json({ error: 'contactId not found in your organization' });
      eventData.contact = c;
    }
    if (dealId) {
      const d = await Deal.findOne({ _id: dealId, organization: req.organizationId });
      if (!d) return res.status(400).json({ error: 'dealId not found in your organization' });
      eventData.deal = d;
    }
    await triggerAutomation(event, eventData);
    res.json({ message: 'Event processed', event });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

export default router;