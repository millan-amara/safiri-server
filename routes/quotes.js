import { Router } from 'express';
import Quote from '../models/Quote.js';
import Organization from '../models/Organization.js';
import Hotel from '../models/Hotel.js';
import { Deal, Pipeline } from '../models/Deal.js';
import { protect, authorize } from '../middleware/auth.js';
import { getAccessiblePipelineIds, userCanSeePipeline } from '../middleware/access.js';
import { requireQuoteQuota, trackQuoteUsage } from '../middleware/subscription.js';
import { createNotification } from './notifications.js';
import { triggerAutomation } from '../automations/engine.js';

const router = Router();

const ADMIN_ROLES = ['owner', 'admin'];
const isAdmin = (user) => ADMIN_ROLES.includes(user.role);

// True if the user can read/write a quote based on its (optional) deal link.
// Quotes with no deal are org-wide accessible.
async function canAccessQuoteDeal(user, quote) {
  if (!quote?.deal) return true;
  if (isAdmin(user)) return true;
  const deal = await Deal.findOne({ _id: quote.deal, organization: user.organization })
    .select('pipeline').lean();
  if (!deal) return true;
  const pipeline = await Pipeline.findOne({ _id: deal.pipeline, organization: user.organization }).lean();
  if (!pipeline) return true;
  return userCanSeePipeline(user, pipeline);
}

// True if the user can link a *new* quote to the given deal id.
async function canLinkToDeal(user, dealId) {
  if (!dealId) return true;
  if (isAdmin(user)) return true;
  const deal = await Deal.findOne({ _id: dealId, organization: user.organization })
    .select('pipeline').lean();
  if (!deal) return false;
  const pipeline = await Pipeline.findOne({ _id: deal.pipeline, organization: user.organization }).lean();
  if (!pipeline) return false;
  return userCanSeePipeline(user, pipeline);
}

// Fill in hotel images on days where the snapshot is missing them
async function hydrateHotelImages(quote) {
  const needs = (quote.days || []).filter(d => d.hotel?.name && !d.hotel.images?.length);
  if (!needs.length) return;
  const ids = [...new Set(needs.map(d => d.hotel.hotelId || d.hotel._id).filter(Boolean).map(String))];
  const names = [...new Set(needs.map(d => d.hotel.name).filter(Boolean))];
  // Both lookup branches MUST be scoped by organization. Without it, a quote
  // with a foreign org's `Hotel._id` planted in days[].hotel.hotelId would
  // pull cross-tenant hotel images.
  const orConds = [];
  if (ids.length) orConds.push({ _id: { $in: ids } });
  if (names.length) orConds.push({ name: { $in: names } });
  if (!orConds.length) return;
  const hotels = await Hotel.find({ organization: quote.organization, $or: orConds }).select('name images').lean();
  const byId = new Map(hotels.map(h => [String(h._id), h.images || []]));
  const byName = new Map(hotels.map(h => [h.name, h.images || []]));
  for (const d of needs) {
    const id = d.hotel.hotelId || d.hotel._id;
    const imgs = (id && byId.get(String(id))) || byName.get(d.hotel.name) || [];
    if (imgs.length) d.hotel.images = imgs;
  }
}

// List quotes
router.get('/', protect, async (req, res) => {
  try {
    const { status, deal, page = 1, limit = 20, templates } = req.query;
    const filter = { organization: req.organizationId };
    // Templates and quotes are separate
    filter.isTemplate = templates === 'true';
    if (status) filter.status = status;
    if (deal) filter.deal = deal;

    // Non-admins only see quotes whose linked deal is in their accessible pipelines
    // (or quotes with no deal link at all — those are org-wide visible).
    if (!isAdmin(req.user)) {
      const accessiblePipelines = await getAccessiblePipelineIds(req.user);
      const accessibleDeals = await Deal.find({
        organization: req.organizationId,
        pipeline: { $in: accessiblePipelines },
        isActive: true,
      }).select('_id').lean();
      const accessibleDealIds = accessibleDeals.map(d => d._id);
      filter.$or = [
        { deal: { $in: accessibleDealIds } },
        { deal: null },
        { deal: { $exists: false } },
      ];
    }

    const quotes = await Quote.find(filter)
      .populate('contact', 'firstName lastName email')
      .populate('deal', 'title')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await Quote.countDocuments(filter);

    res.json({ quotes, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get single quote (for editing)
router.get('/:id', protect, async (req, res) => {
  try {
    const quote = await Quote.findOne({ _id: req.params.id, organization: req.organizationId })
      .populate('contact')
      .populate('deal', 'title')
      .populate('createdBy', 'name');
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    if (!(await canAccessQuoteDeal(req.user, quote))) {
      return res.status(403).json({ message: 'No access to this quote' });
    }
    res.json(quote);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Sanitize days — strip empty subdocuments
function sanitizeDays(days) {
  if (!Array.isArray(days)) return days;
  return days.map(day => {
    const clean = { ...day };
    if (clean.transport && !clean.transport.name) delete clean.transport;
    if (clean.hotel && !clean.hotel.name) delete clean.hotel;
    if (Array.isArray(clean.activities)) clean.activities = clean.activities.filter(a => a.name || a.activityId);
    if (Array.isArray(clean.images)) clean.images = clean.images.filter(img => img.url);
    return clean;
  });
}

// Create quote
router.post('/', protect, authorize('owner', 'admin', 'agent'), requireQuoteQuota, async (req, res) => {
  try {
    if (req.body.deal && !(await canLinkToDeal(req.user, req.body.deal))) {
      return res.status(403).json({ message: 'No access to the linked deal' });
    }
    // Snapshot branding at creation time (need full doc for branding fields)
    const org = await Organization.findById(req.organizationId);
    const brandingSnapshot = {
      logo: org.branding.logo,
      primaryColor: org.branding.primaryColor,
      secondaryColor: org.branding.secondaryColor,
      companyName: org.name,
      companyEmail: org.businessInfo.email,
      companyPhone: org.businessInfo.phone,
      companyAddress: org.businessInfo.address,
      aboutUs: org.businessInfo.aboutUs,
      coverQuote: org.branding.coverQuote,
      coverQuoteAuthor: org.branding.coverQuoteAuthor,
    };

    const body = { ...req.body };
    if (body.days) body.days = sanitizeDays(body.days);
    if (body.contact === '' || body.contact === null) delete body.contact;
    if (body.deal === '' || body.deal === null) delete body.deal;

    const quote = await Quote.create({
      ...body,
      organization: req.organizationId,
      createdBy: req.user._id,
      brandingSnapshot,
      inclusions: body.inclusions || org.defaults.inclusions,
      exclusions: body.exclusions || org.defaults.exclusions,
      paymentTerms: body.paymentTerms || org.defaults.paymentTerms,
      pricing: {
        ...body.pricing,
        marginPercent: body.pricing?.marginPercent ?? org.defaults.marginPercent,
        currency: body.pricing?.currency || org.defaults.currency,
      },
    });

    // Increment trial quote counter (no-op if not on trial)
    await trackQuoteUsage(req.organizationId, req.organization?.plan);

    res.status(201).json(quote);
  } catch (error) {
    console.error('Quote create error:', error.message);
    if (error.errors) {
      console.error('Validation details:', JSON.stringify(
        Object.fromEntries(Object.entries(error.errors).map(([k, v]) => [k, v.message])),
        null, 2
      ));
    }
    res.status(500).json({ message: error.message });
  }
});

// Update quote
// Whitelist of fields a caller can modify on an existing quote. Anything else
// (organization, createdBy, quoteNumber, shareToken, tracking, etc.) is
// dropped — preventing cross-tenant moves and identity spoofing via PUT body.
const QUOTE_EDITABLE_FIELDS = [
  'title', 'tripTitle', 'startDate', 'endDate', 'startPoint', 'endPoint',
  'travelers', 'adults', 'childAges', 'clientType', 'nationality',
  'currency', 'days', 'pricing', 'inclusions', 'exclusions', 'notes',
  'coverNarrative', 'closingNote', 'highlights', 'pdfStyle', 'coverLayout',
  'brandingSnapshot', 'shareSettings', 'status',
  'contact', 'deal',
];

router.put('/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const body = {};
    for (const f of QUOTE_EDITABLE_FIELDS) {
      if (req.body[f] !== undefined) body[f] = req.body[f];
    }
    if (body.days) body.days = sanitizeDays(body.days);
    if (body.contact === '' || body.contact === null) body.contact = undefined;
    if (body.deal === '' || body.deal === null) body.deal = undefined;

    const prior = await Quote.findOne({ _id: req.params.id, organization: req.organizationId }).select('status deal contact').lean();
    if (!prior) return res.status(404).json({ message: 'Not found' });
    if (!(await canAccessQuoteDeal(req.user, prior))) {
      return res.status(403).json({ message: 'No access to this quote' });
    }
    // If user is moving the quote to a different deal, they must also have access to the target.
    if (body.deal && String(body.deal) !== String(prior.deal || '') && !(await canLinkToDeal(req.user, body.deal))) {
      return res.status(403).json({ message: 'No access to the target deal' });
    }
    const quote = await Quote.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      body,
      { new: true }
    );
    if (!quote) return res.status(404).json({ message: 'Not found' });

    if (prior && prior.status !== 'sent' && quote.status === 'sent') {
      triggerAutomation('quote.sent', {
        organizationId: req.organizationId,
        deal: quote.deal ? { _id: quote.deal } : null,
        contact: quote.contact ? { _id: quote.contact } : null,
        userId: req.user._id,
      });
    }

    res.json(quote);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new version of a quote
router.post('/:id/version', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const original = await Quote.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!original) return res.status(404).json({ message: 'Quote not found' });
    if (!(await canAccessQuoteDeal(req.user, original))) {
      return res.status(403).json({ message: 'No access to this quote' });
    }

    // Clone the quote
    const cloneData = original.toObject();
    delete cloneData._id;
    delete cloneData.createdAt;
    delete cloneData.updatedAt;
    delete cloneData.__v;
    delete cloneData.quoteNumber;
    delete cloneData.shareToken;
    if (cloneData.days) cloneData.days = sanitizeDays(cloneData.days);

    const newQuote = await Quote.create({
      ...cloneData,
      version: (original.version || 1) + 1,
      parentQuote: original._id,
      status: 'draft',
      tracking: { views: 0, viewLog: [] },
      createdBy: req.user._id,
    });

    res.status(201).json(newQuote);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get version history
router.get('/:id/versions', protect, async (req, res) => {
  try {
    const quote = await Quote.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!quote) return res.status(404).json({ message: 'Not found' });

    // Find all versions in the chain
    const rootId = quote.parentQuote || quote._id;
    const versions = await Quote.find({
      organization: req.organizationId,
      $or: [{ _id: rootId }, { parentQuote: rootId }],
    })
      .select('quoteNumber version status createdAt pricing.totalPrice shareToken')
      .sort({ version: 1 });

    res.json({ versions, currentId: quote._id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Save quote as template
router.post('/:id/save-as-template', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { templateName, templateDescription } = req.body;
    if (!templateName?.trim()) return res.status(400).json({ message: 'Template name required' });

    const original = await Quote.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!original) return res.status(404).json({ message: 'Quote not found' });
    if (!(await canAccessQuoteDeal(req.user, original))) {
      return res.status(403).json({ message: 'No access to this quote' });
    }

    const cloneData = original.toObject();
    delete cloneData._id;
    delete cloneData.createdAt;
    delete cloneData.updatedAt;
    delete cloneData.__v;
    delete cloneData.quoteNumber;
    delete cloneData.shareToken;
    if (cloneData.days) cloneData.days = sanitizeDays(cloneData.days);

    const template = await Quote.create({
      ...cloneData,
      isTemplate: true,
      templateName: templateName.trim(),
      templateDescription: templateDescription?.trim() || '',
      title: templateName.trim(),
      // Reset trip-specific data
      contact: null,
      deal: null,
      startDate: null,
      endDate: null,
      status: 'draft',
      version: 1,
      parentQuote: null,
      tracking: { views: 0, viewLog: [] },
      createdBy: req.user._id,
    });

    res.status(201).json(template);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Duplicate template into a new quote
router.post('/templates/:id/use', protect, authorize('owner', 'admin', 'agent'), requireQuoteQuota, async (req, res) => {
  try {
    const template = await Quote.findOne({ _id: req.params.id, organization: req.organizationId, isTemplate: true });
    if (!template) return res.status(404).json({ message: 'Template not found' });
    if (req.body.dealId && !(await canLinkToDeal(req.user, req.body.dealId))) {
      return res.status(403).json({ message: 'No access to the target deal' });
    }

    const cloneData = template.toObject();
    delete cloneData._id;
    delete cloneData.createdAt;
    delete cloneData.updatedAt;
    delete cloneData.__v;
    delete cloneData.quoteNumber;
    delete cloneData.shareToken;
    if (cloneData.days) cloneData.days = sanitizeDays(cloneData.days);

    const newQuote = await Quote.create({
      ...cloneData,
      isTemplate: false,
      templateName: '',
      templateDescription: '',
      title: req.body.title || `${template.templateName} (copy)`,
      contact: req.body.contactId || null,
      deal: req.body.dealId || null,
      status: 'draft',
      version: 1,
      parentQuote: null,
      tracking: { views: 0, viewLog: [] },
      createdBy: req.user._id,
    });

    await trackQuoteUsage(req.organizationId, req.organization?.plan);

    res.status(201).json(newQuote);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete quote
router.delete('/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const quote = await Quote.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!quote) return res.status(404).json({ message: 'Not found' });
    if (!(await canAccessQuoteDeal(req.user, quote))) {
      return res.status(403).json({ message: 'No access to this quote' });
    }
    await Quote.findByIdAndDelete(quote._id);
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── PUBLIC SHARE LINK (no auth needed) ────────────────

router.get('/share/:token', async (req, res) => {
  try {
    const quote = await Quote.findOne({ shareToken: req.params.token })
      .populate('createdBy', 'name email phone jobTitle avatar signature signatureNote')
      .populate('contact', 'firstName lastName email country');
    if (!quote) return res.status(404).json({ message: 'Quote not found' });

    if (quote.shareSettings.expiresAt && new Date() > quote.shareSettings.expiresAt) {
      return res.status(410).json({ message: 'This quote has expired' });
    }

    // Track view
    quote.tracking.views += 1;
    quote.tracking.lastViewedAt = new Date();
    quote.tracking.viewLog.push({
      viewedAt: new Date(),
      device: req.headers['user-agent'] || 'unknown',
      location: req.ip,
    });

    if (quote.status === 'sent') {
      quote.status = 'viewed';
      // Notify quote creator
      if (quote.createdBy) {
        createNotification({
          organization: quote.organization,
          user: quote.createdBy,
          type: 'quote_viewed',
          title: `Quote #${quote.quoteNumber} was opened`,
          message: quote.title,
          entityType: 'quote',
          entityId: quote._id,
        });
      }
      triggerAutomation('quote.viewed', {
        organizationId: quote.organization,
        deal: quote.deal ? { _id: quote.deal } : null,
        contact: quote.contact ? { _id: quote.contact._id || quote.contact } : null,
        userId: quote.createdBy?._id || quote.createdBy,
      });
    }

    await quote.save();

    // Build a public-safe projection. Spreading quote.toObject() leaks the
    // operator's margin/cost, every prior viewer's IP/UA via tracking.viewLog,
    // creator phone/email, internal notes, etc. Whitelist fields explicitly
    // and sanitize pricing to never include cost or margin.
    const full = quote.toObject();

    // Hydrate branding/hotel images on the working copy first so the share
    // payload has the merged data the client view expects.
    const snap = full.brandingSnapshot || {};
    if (!snap.coverQuote || !snap.aboutUs) {
      const org = await Organization.findById(full.organization).select('branding businessInfo').lean();
      if (org) {
        full.brandingSnapshot = {
          ...snap,
          coverQuote: snap.coverQuote || org.branding?.coverQuote || '',
          coverQuoteAuthor: snap.coverQuoteAuthor || org.branding?.coverQuoteAuthor || '',
          aboutUs: snap.aboutUs || org.businessInfo?.aboutUs || '',
        };
      }
    }
    await hydrateHotelImages(full);

    // Strip cost / margin from pricing regardless of displayMode — the client
    // never needs to see the operator's internal numbers.
    const safePricing = full.pricing ? { ...full.pricing } : {};
    delete safePricing.cost;
    delete safePricing.marginAmount;
    delete safePricing.marginPercent;
    if (safePricing.displayMode === 'total_only') {
      delete safePricing.subtotal;
    }

    // Createdby — only public-facing fields. Email/phone aren't surfaced to
    // the client unless the operator explicitly opts them into branding.
    const createdBy = full.createdBy && {
      name: full.createdBy.name,
      jobTitle: full.createdBy.jobTitle,
      avatar: full.createdBy.avatar,
      signature: full.createdBy.signature,
      signatureNote: full.createdBy.signatureNote,
    };

    // Contact — first name + country only (so the client sees personalised
    // greeting), never the full email/phone of whoever is being quoted.
    const contact = full.contact && {
      firstName: full.contact.firstName,
      lastName: full.contact.lastName,
      country: full.contact.country,
    };

    res.json({
      _id: full._id,
      quoteNumber: full.quoteNumber,
      title: full.title,
      tripTitle: full.tripTitle,
      version: full.version,
      status: full.status,
      startDate: full.startDate,
      endDate: full.endDate,
      startPoint: full.startPoint,
      endPoint: full.endPoint,
      travelers: full.travelers,
      adults: full.adults,
      childAges: full.childAges,
      currency: full.currency,
      days: full.days,
      pricing: safePricing,
      inclusions: full.inclusions,
      exclusions: full.exclusions,
      coverNarrative: full.coverNarrative,
      closingNote: full.closingNote,
      highlights: full.highlights,
      pdfStyle: full.pdfStyle,
      coverLayout: full.coverLayout,
      brandingSnapshot: full.brandingSnapshot,
      shareSettings: full.shareSettings,
      createdBy,
      contact,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Client accepts quote (public, no auth)
router.post('/share/:token/accept', async (req, res) => {
  try {
    const quote = await Quote.findOne({ shareToken: req.params.token });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });

    if (quote.shareSettings?.expiresAt && new Date() > quote.shareSettings.expiresAt) {
      return res.status(410).json({ message: 'This quote has expired' });
    }

    // Idempotent: if already accepted, return success without re-running side effects.
    if (quote.status === 'accepted') {
      return res.json({ message: 'Quote already accepted', status: 'accepted' });
    }
    // Only quotes the operator has actually surfaced to the client are acceptable —
    // a 'draft' or already-'rejected' quote being flipped to 'accepted' via this
    // public endpoint would be a bypass of the operator's intent.
    if (!['sent', 'viewed'].includes(quote.status)) {
      return res.status(409).json({ message: 'Quote is not in an acceptable state' });
    }

    quote.status = 'accepted';
    quote.activities = quote.activities || [];

    // Log acceptance
    quote.tracking.viewLog.push({
      viewedAt: new Date(),
      device: req.headers['user-agent'] || 'unknown',
      location: req.ip,
    });

    await quote.save();

    // Notify quote creator
    if (quote.createdBy) {
      createNotification({
        organization: quote.organization,
        user: quote.createdBy,
        type: 'system',
        title: `Quote #${quote.quoteNumber} accepted!`,
        message: `${quote.title} has been accepted by the client`,
        entityType: 'quote',
        entityId: quote._id,
      });
    }

    // Update linked deal stage. Scope by organization so a tampered quote.deal
    // pointer can't mutate a foreign-tenant deal. Resolve the won-stage name
    // from the deal's pipeline rather than hardcoding 'Won'.
    if (quote.deal) {
      const { Deal, Pipeline } = await import('../models/Deal.js');
      const deal = await Deal.findOne({ _id: quote.deal, organization: quote.organization });
      if (deal) {
        let wonStageName = 'Won';
        const pipeline = await Pipeline.findOne({ _id: deal.pipeline, organization: quote.organization }).lean();
        const wonStage = pipeline?.stages?.find(s => s.type === 'won');
        if (wonStage?.name) wonStageName = wonStage.name;

        deal.stage = wonStageName;
        deal.wonAt = new Date();
        deal.activities.push({
          type: 'quote_sent',
          description: `Client accepted quote #${quote.quoteNumber}`,
          createdAt: new Date(),
        });
        await deal.save();
      }
    }

    res.json({ message: 'Quote accepted', status: 'accepted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Client requests changes (public, no auth)
router.post('/share/:token/request-changes', async (req, res) => {
  try {
    const quote = await Quote.findOne({ shareToken: req.params.token });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });

    if (quote.shareSettings?.expiresAt && new Date() > quote.shareSettings.expiresAt) {
      return res.status(410).json({ message: 'This quote has expired' });
    }

    // Cap user-controlled fields so a malicious client can't fill the deal
    // activity log with arbitrarily large payloads (denial-of-service / abuse).
    const cap = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
    const message = cap(req.body?.message, 2000);
    const clientName = cap(req.body?.clientName, 200);
    const clientEmail = cap(req.body?.clientEmail, 200);

    // Add to activity log on linked deal — scoped to the quote's organization
    // so a tampered quote.deal pointer can't write to a foreign-tenant deal.
    if (quote.deal) {
      const { Deal } = await import('../models/Deal.js');
      await Deal.findOneAndUpdate(
        { _id: quote.deal, organization: quote.organization },
        {
          $push: {
            activities: {
              type: 'quote_sent',
              description: `Client requested changes on quote #${quote.quoteNumber}: "${message}"`,
              createdAt: new Date(),
              metadata: { clientName, clientEmail, changeRequest: message },
            },
          },
        }
      );
    }

    // Notify quote creator
    if (quote.createdBy) {
      createNotification({
        organization: quote.organization,
        user: quote.createdBy,
        type: 'system',
        title: `Changes requested on Quote #${quote.quoteNumber}`,
        message: message || 'Client requested changes',
        entityType: 'quote',
        entityId: quote._id,
      });
    }

    res.json({ message: 'Request sent' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;