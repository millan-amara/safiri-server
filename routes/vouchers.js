import { Router } from 'express';
import Voucher from '../models/Voucher.js';
import Hotel from '../models/Hotel.js';
import Quote from '../models/Quote.js';
import { Deal, Pipeline } from '../models/Deal.js';
import Organization from '../models/Organization.js';
import { protect, authorize } from '../middleware/auth.js';
import { userCanSeePipeline, getAccessiblePipelineIds } from '../middleware/access.js';
import { buildVoucherPdf, fmtVoucherNumber } from '../services/voucherPdf.js';
import {
  nextVoucherNumber,
  previewVouchersFromQuote,
  generateVouchersFromQuote,
} from '../services/voucherGenerator.js';
import { sendEmail, voucherEmail, operatorSenderName } from '../utils/email.js';

const router = Router();

const ADMIN_ROLES = ['owner', 'admin'];
const isAdmin = (user) => ADMIN_ROLES.includes(user.role);

// Pipeline-access gating, mirroring routes/invoices.js. Vouchers inherit the
// access rules of their parent deal — no separate ACL.
async function loadAccessibleDeal(req, dealId) {
  const deal = await Deal.findOne({ _id: dealId, organization: req.organizationId })
    .populate('contact', 'firstName lastName email phone company');
  if (!deal) return { error: { status: 404, message: 'Deal not found' } };
  const pipeline = await Pipeline.findOne({
    _id: deal.pipeline,
    organization: req.organizationId,
  }).lean();
  if (!pipeline || !userCanSeePipeline(req.user, pipeline)) {
    return { error: { status: 403, message: 'No access to this deal' } };
  }
  return { deal, pipeline };
}

async function loadAccessibleVoucher(req, voucherId) {
  const voucher = await Voucher.findOne({ _id: voucherId, organization: req.organizationId });
  if (!voucher) return { error: { status: 404, message: 'Voucher not found' } };
  const { deal, error } = await loadAccessibleDeal(req, voucher.deal);
  if (error) return { error };
  return { voucher, deal };
}

// LIST — per-deal panel (?deal=) or org-wide
router.get('/', protect, async (req, res) => {
  try {
    const { deal: dealId, status, page = 1, limit = 50 } = req.query;
    const filter = { organization: req.organizationId };

    if (dealId) {
      const { error } = await loadAccessibleDeal(req, dealId);
      if (error) return res.status(error.status).json({ message: error.message });
      filter.deal = dealId;
    } else if (!isAdmin(req.user)) {
      const accessiblePipelines = await getAccessiblePipelineIds(req.user);
      const accessibleDeals = await Deal.find({
        organization: req.organizationId,
        pipeline: { $in: accessiblePipelines },
        isActive: true,
      }).select('_id').lean();
      filter.deal = { $in: accessibleDeals.map(d => d._id) };
    }

    if (status) filter.status = status;

    const vouchers = await Voucher.find(filter)
      .populate('deal', 'title')
      .populate('createdBy', 'name avatar')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await Voucher.countDocuments(filter);
    res.json({ vouchers, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/:id', protect, async (req, res) => {
  try {
    const { voucher, error } = await loadAccessibleVoucher(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    res.json(voucher);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// CREATE — operator picks hotel + dates from a modal. Hotel snapshot is taken
// here so future edits to the source Hotel doc don't mutate this voucher.
router.post('/', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { dealId, hotelId, hotel: hotelOverride, ...rest } = req.body;
    if (!dealId) return res.status(400).json({ message: 'dealId is required' });
    if (!rest.checkIn || !rest.checkOut) {
      return res.status(400).json({ message: 'checkIn and checkOut are required' });
    }

    const { deal, error } = await loadAccessibleDeal(req, dealId);
    if (error) return res.status(error.status).json({ message: error.message });

    // Snapshot the hotel — prefer the live Hotel doc if hotelId given, otherwise
    // accept the operator's free-typed override (handles ad-hoc lodges not in
    // the catalog).
    let hotelSnapshot = {
      name: hotelOverride?.name || '',
      location: hotelOverride?.location || '',
      address: hotelOverride?.address || '',
      contactEmail: hotelOverride?.contactEmail || '',
      contactPhone: hotelOverride?.contactPhone || '',
    };
    let hotelRef = null;
    if (hotelId) {
      const h = await Hotel.findOne({ _id: hotelId, organization: req.organizationId }).lean();
      if (h) {
        hotelRef = h._id;
        hotelSnapshot = {
          name: h.name || hotelSnapshot.name,
          location: [h.location, h.destination].filter(Boolean).join(', ') || hotelSnapshot.location,
          address: hotelSnapshot.address,
          contactEmail: h.contactEmail || hotelSnapshot.contactEmail,
          contactPhone: h.contactPhone || hotelSnapshot.contactPhone,
        };
      }
    }

    // Default the guest to the deal's contact if not supplied.
    const guest = rest.guest || {};
    if (!guest.name && deal.contact) {
      guest.name = `${deal.contact.firstName || ''} ${deal.contact.lastName || ''}`.trim();
      guest.email = guest.email || deal.contact.email || '';
      guest.phone = guest.phone || deal.contact.phone || '';
    }

    const voucher = await Voucher.create({
      organization: req.organizationId,
      deal: deal._id,
      contact: deal.contact?._id || null,
      createdBy: req.user._id,
      voucherNumber: await nextVoucherNumber(req.organizationId),
      hotelRef,
      hotel: hotelSnapshot,
      guest,
      adults: Number(rest.adults) || 1,
      children: Number(rest.children) || 0,
      checkIn: new Date(rest.checkIn),
      checkOut: new Date(rest.checkOut),
      roomType: rest.roomType || '',
      rooms: Number(rest.rooms) || 1,
      mealPlan: rest.mealPlan || '',
      confirmationNumber: rest.confirmationNumber || '',
      bookingReference: rest.bookingReference || '',
      inclusions: Array.isArray(rest.inclusions) ? rest.inclusions : [],
      exclusions: Array.isArray(rest.exclusions) ? rest.exclusions : [],
      specialRequests: rest.specialRequests || '',
      notes: rest.notes || '',
    });

    res.status(201).json(voucher);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Voucher number collision — please retry' });
    }
    res.status(500).json({ message: error.message });
  }
});

// UPDATE — drafts only. Issued vouchers are immutable so the lodge's copy
// stays authoritative.
router.put('/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { voucher, error } = await loadAccessibleVoucher(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (voucher.status !== 'draft') {
      return res.status(400).json({ message: 'Only draft vouchers can be edited.' });
    }

    const editable = [
      'hotel', 'guest', 'adults', 'children', 'checkIn', 'checkOut',
      'roomType', 'rooms', 'mealPlan', 'confirmationNumber', 'bookingReference',
      'inclusions', 'exclusions', 'specialRequests', 'notes',
    ];
    for (const f of editable) {
      if (f in req.body) voucher[f] = req.body[f];
    }
    await voucher.save();
    res.json(voucher);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ISSUE — flips draft → issued and stamps issuedAt. Separate from email send
// so an operator can issue a voucher and hand-deliver / WhatsApp the PDF.
router.post('/:id/issue', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { voucher, error } = await loadAccessibleVoucher(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (voucher.status !== 'draft') {
      return res.status(400).json({ message: 'Only draft vouchers can be issued.' });
    }
    voucher.status = 'issued';
    voucher.issuedAt = new Date();
    await voucher.save();
    res.json(voucher);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/cancel', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { voucher, error } = await loadAccessibleVoucher(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    voucher.status = 'cancelled';
    voucher.cancelledAt = new Date();
    await voucher.save();
    res.json(voucher);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { voucher, error } = await loadAccessibleVoucher(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (voucher.status === 'issued') {
      return res.status(400).json({ message: 'Issued vouchers cannot be deleted — cancel instead.' });
    }
    await Voucher.findByIdAndDelete(voucher._id);
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// PDF download — inline so browsers preview, but Save dialog still works.
router.get('/:id/pdf', protect, async (req, res) => {
  try {
    const { voucher, error } = await loadAccessibleVoucher(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    const org = await Organization.findById(req.organizationId).lean();
    const pdfBuffer = await buildVoucherPdf(voucher, org);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fmtVoucherNumber(voucher.voucherNumber)}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Voucher PDF generation failed:', error.message);
    res.status(500).json({ message: error.message });
  }
});

// PREVIEW — dry-run of generate-from-quote. Returns the stay segments that
// would be created so the modal can show "Generate 3 drafts (1 already exists)".
router.get('/preview-from-quote/:quoteId', protect, async (req, res) => {
  try {
    const quote = await Quote.findOne({
      _id: req.params.quoteId,
      organization: req.organizationId,
    }).lean();
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    if (!quote.deal) {
      return res.status(400).json({ message: 'Quote is not linked to a deal — vouchers must belong to a deal.' });
    }
    const { error: accessError } = await loadAccessibleDeal(req, quote.deal);
    if (accessError) return res.status(accessError.status).json({ message: accessError.message });

    const existing = await Voucher.find({
      organization: req.organizationId,
      deal: quote.deal,
    }).select('hotel checkIn status').lean();

    const result = await previewVouchersFromQuote(quote, existing);
    if (result.error) return res.status(400).json({ message: result.error });

    res.json({
      quote: {
        _id: quote._id,
        quoteNumber: quote.quoteNumber,
        title: quote.title,
        status: quote.status,
        version: quote.version,
        startDate: quote.startDate,
        endDate: quote.endDate,
      },
      segments: result.segments,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GENERATE — create draft vouchers for every accommodation segment in the
// quote. Skips segments that already have a non-cancelled voucher (so re-running
// after adding a stop is safe). Delegates the create loop to the shared
// generator service so the auto-on-Won path uses the exact same logic.
router.post('/generate-from-quote', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { quoteId } = req.body;
    if (!quoteId) return res.status(400).json({ message: 'quoteId is required' });

    const quote = await Quote.findOne({
      _id: quoteId,
      organization: req.organizationId,
    }).lean();
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    if (!quote.deal) {
      return res.status(400).json({ message: 'Quote is not linked to a deal.' });
    }

    const { deal, error: accessError } = await loadAccessibleDeal(req, quote.deal);
    if (accessError) return res.status(accessError.status).json({ message: accessError.message });

    const result = await generateVouchersFromQuote({
      quote,
      deal,
      organizationId: req.organizationId,
      userId: req.user._id,
    });
    if (result.error) return res.status(400).json({ message: result.error });

    // If every attempt failed, this isn't a partial success — return 500 with
    // the first error so the operator knows something is actually broken.
    const attempts = (result.total || 0) - (result.skipped || 0);
    if (attempts > 0 && result.created.length === 0) {
      return res.status(500).json({
        message: result.failed[0]?.message || 'Failed to generate vouchers',
        failed: result.failed,
      });
    }

    res.status(201).json({
      created: result.created,
      skipped: result.skipped,
      failed: result.failed,
      total: result.total,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// EMAIL — sends the PDF as an attachment. `to` accepts a comma-separated list
// or array; `replyTo` defaults to the operator's email so client replies land
// with the agent who sent it, not the noreply box.
router.post('/:id/email', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { voucher, error } = await loadAccessibleVoucher(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });

    const recipients = Array.isArray(req.body.to)
      ? req.body.to
      : String(req.body.to || '').split(',').map(s => s.trim()).filter(Boolean);
    if (recipients.length === 0) {
      return res.status(400).json({ message: 'At least one recipient is required.' });
    }

    // Guard against sending vouchers without the lodge's PRN. The auto-on-Won
    // flow creates drafts with no confirmationNumber on purpose — sending one
    // out before the operator pastes the PRN gives the lodge a useless doc.
    // The frontend can pass force: true to override after explicit confirmation.
    if (!String(voucher.confirmationNumber || '').trim() && req.body.force !== true) {
      return res.status(400).json({
        message: 'Voucher has no confirmation number (PRN). Add the lodge confirmation before sending, or pass force: true to override.',
        code: 'PRN_MISSING',
      });
    }

    const org = await Organization.findById(req.organizationId).lean();
    const pdfBuffer = await buildVoucherPdf(voucher, org);
    const filename = `${fmtVoucherNumber(voucher.voucherNumber)}.pdf`;

    const html = voucherEmail({
      guestName: voucher.guest?.name,
      hotelName: voucher.hotel?.name,
      checkIn: voucher.checkIn,
      checkOut: voucher.checkOut,
      voucherNumber: fmtVoucherNumber(voucher.voucherNumber),
      orgName: org?.name,
      message: req.body.message || '',
    });

    await sendEmail({
      to: recipients,
      subject: req.body.subject || `Hotel voucher ${fmtVoucherNumber(voucher.voucherNumber)} — ${voucher.hotel?.name || ''}`.trim(),
      html,
      replyTo: req.user.email,
      senderName: operatorSenderName({ user: req.user, org }),
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
    });

    voucher.lastSentAt = new Date();
    voucher.lastSentTo = recipients;
    if (voucher.status === 'draft') {
      voucher.status = 'issued';
      voucher.issuedAt = new Date();
    }
    await voucher.save();

    res.json(voucher);
  } catch (error) {
    console.error('Voucher email failed:', error.message);
    res.status(500).json({ message: error.message });
  }
});

export default router;
