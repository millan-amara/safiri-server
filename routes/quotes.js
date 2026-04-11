import { Router } from 'express';
import Quote from '../models/Quote.js';
import Organization from '../models/Organization.js';
import { protect } from '../middleware/auth.js';
import { createNotification } from './notifications.js';

const router = Router();

// List quotes
router.get('/', protect, async (req, res) => {
  try {
    const { status, deal, page = 1, limit = 20, templates } = req.query;
    const filter = { organization: req.organizationId };
    // Templates and quotes are separate
    filter.isTemplate = templates === 'true';
    if (status) filter.status = status;
    if (deal) filter.deal = deal;

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
router.post('/', protect, async (req, res) => {
  try {
    // Snapshot branding at creation time
    const org = await Organization.findById(req.organizationId);
    const brandingSnapshot = {
      logo: org.branding.logo,
      primaryColor: org.branding.primaryColor,
      secondaryColor: org.branding.secondaryColor,
      companyName: org.name,
      companyEmail: org.businessInfo.email,
      companyPhone: org.businessInfo.phone,
      companyAddress: org.businessInfo.address,
    };

    const body = { ...req.body };
    if (body.days) body.days = sanitizeDays(body.days);

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
router.put('/:id', protect, async (req, res) => {
  try {
    const body = { ...req.body };
    if (body.days) body.days = sanitizeDays(body.days);

    const quote = await Quote.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      body,
      { new: true }
    );
    if (!quote) return res.status(404).json({ message: 'Not found' });
    res.json(quote);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new version of a quote
router.post('/:id/version', protect, async (req, res) => {
  try {
    const original = await Quote.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!original) return res.status(404).json({ message: 'Quote not found' });

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
router.post('/:id/save-as-template', protect, async (req, res) => {
  try {
    const { templateName, templateDescription } = req.body;
    if (!templateName?.trim()) return res.status(400).json({ message: 'Template name required' });

    const original = await Quote.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!original) return res.status(404).json({ message: 'Quote not found' });

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
router.post('/templates/:id/use', protect, async (req, res) => {
  try {
    const template = await Quote.findOne({ _id: req.params.id, organization: req.organizationId, isTemplate: true });
    if (!template) return res.status(404).json({ message: 'Template not found' });

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

    res.status(201).json(newQuote);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete quote
router.delete('/:id', protect, async (req, res) => {
  try {
    await Quote.findOneAndDelete({ _id: req.params.id, organization: req.organizationId });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── PUBLIC SHARE LINK (no auth needed) ────────────────

router.get('/share/:token', async (req, res) => {
  try {
    const quote = await Quote.findOne({ shareToken: req.params.token });
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
    }

    await quote.save();

    // Return clean version for client (no internal pricing)
    const clientQuote = quote.toObject();
    if (clientQuote.pricing.displayMode === 'total_only') {
      delete clientQuote.pricing.subtotal;
      delete clientQuote.pricing.marginPercent;
      delete clientQuote.pricing.marginAmount;
    }

    res.json(clientQuote);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Client accepts quote (public, no auth)
router.post('/share/:token/accept', async (req, res) => {
  try {
    const quote = await Quote.findOne({ shareToken: req.params.token });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });

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

    // Update linked deal stage
    if (quote.deal) {
      const { Deal } = await import('../models/Deal.js');
      await Deal.findByIdAndUpdate(quote.deal, {
        stage: 'Won',
        wonAt: new Date(),
        $push: {
          activities: {
            type: 'quote_sent',
            description: `Client accepted quote #${quote.quoteNumber}`,
            createdAt: new Date(),
          },
        },
      });
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

    const { message, clientName, clientEmail } = req.body;

    // Add to activity log on linked deal
    if (quote.deal) {
      const { Deal } = await import('../models/Deal.js');
      await Deal.findByIdAndUpdate(quote.deal, {
        $push: {
          activities: {
            type: 'quote_sent',
            description: `Client requested changes on quote #${quote.quoteNumber}: "${message}"`,
            createdAt: new Date(),
            metadata: { clientName, clientEmail, changeRequest: message },
          },
        },
      });
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