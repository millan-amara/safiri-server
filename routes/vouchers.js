import { Router } from 'express';
import Voucher from '../models/Voucher.js';
import Hotel from '../models/Hotel.js';
import Quote from '../models/Quote.js';
import { Deal, Pipeline } from '../models/Deal.js';
import Organization from '../models/Organization.js';
import { protect, authorize } from '../middleware/auth.js';
import { userCanSeePipeline, getAccessiblePipelineIds } from '../middleware/access.js';
import { buildVoucherPdf, fmtVoucherNumber } from '../services/voucherPdf.js';
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

// Per-org auto-incrementing voucher number. Same pattern as invoices.
async function nextVoucherNumber(organizationId) {
  const last = await Voucher.findOne({ organization: organizationId })
    .sort({ voucherNumber: -1 })
    .select('voucherNumber')
    .lean();
  return (last?.voucherNumber || 0) + 1;
}

// Derive a meal-plan code from the per-day meals booleans on a quote.day.
// All three meals → FB; B+L or B+D → HB; just breakfast → BB; nothing → ''.
// Multi-day stays inherit the FIRST day's plan — operator can edit per-voucher.
function mealPlanFromMeals(meals) {
  if (!meals) return '';
  const { breakfast, lunch, dinner } = meals;
  if (breakfast && lunch && dinner) return 'FB';
  if (breakfast && (lunch || dinner)) return 'HB';
  if (breakfast) return 'BB';
  return '';
}

// Add `n` days to a Date without timezone drift (avoids DST half-day rounding).
function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Walk quote.days, group consecutive nights at the same hotel into stay
// segments. A "different hotel" boundary or a day with no hotel ends a group.
// Days without hotels (transit / arrival before first lodge) are skipped.
//
// Returns: [{ hotelSnapshot, roomType, mealPlan, firstDay, lastDay, nights }]
// where firstDay/lastDay are dayNumber (1-indexed). checkIn/out are computed
// later from the quote's startDate.
function groupConsecutiveStays(days) {
  const groups = [];
  let current = null;

  // Sort defensively — days SHOULD already be in dayNumber order, but defend
  // against quotes whose days array got reordered in the UI without resorting.
  const sorted = [...(days || [])].sort((a, b) => (a.dayNumber || 0) - (b.dayNumber || 0));

  for (const day of sorted) {
    const hotel = day.hotel;
    if (!hotel?.name) {
      // No accommodation this night — close any open group.
      if (current) { groups.push(current); current = null; }
      continue;
    }

    // Same hotel as previous? Extend the current group. Match by hotelId
    // first (more reliable than name when an org has two lodges with the
    // same display name), fall back to name.
    const sameAsPrev = current
      && (
        (current.hotelId && (hotel.hotelId || hotel._id) && String(current.hotelId) === String(hotel.hotelId || hotel._id))
        || (!current.hotelId && current.name === hotel.name)
      );

    if (sameAsPrev) {
      current.lastDay = day.dayNumber;
    } else {
      if (current) groups.push(current);
      current = {
        hotelId: hotel.hotelId || hotel._id || null,
        name: hotel.name,
        location: [hotel.location, hotel.destination].filter(Boolean).join(', '),
        contactEmail: hotel.contactEmail || '',
        contactPhone: hotel.contactPhone || '',
        roomType: day.roomType || '',
        mealPlan: mealPlanFromMeals(day.meals),
        firstDay: day.dayNumber,
        lastDay: day.dayNumber,
      };
    }
  }
  if (current) groups.push(current);

  // nights = (lastDay - firstDay) + 1. checkOut is the morning AFTER lastDay.
  return groups.map(g => ({ ...g, nights: (g.lastDay - g.firstDay) + 1 }));
}

// Preview what generate-from-quote WOULD create. Used by the modal to show
// the operator a list of stays before they commit. Also computes which
// segments would be skipped because a non-cancelled voucher already exists.
async function previewVouchersFromQuote(quote, existingVouchers) {
  if (!quote.startDate) {
    return { error: 'Quote has no start date — set travel dates before generating vouchers.' };
  }

  const groups = groupConsecutiveStays(quote.days);
  if (groups.length === 0) {
    return { error: 'No hotels found in this quote.' };
  }

  // Dedup key: hotelName + checkInISO. Same hotel on different dates is a
  // separate stay (split visit), so dates matter.
  const existingKeys = new Set(
    (existingVouchers || [])
      .filter(v => v.status !== 'cancelled')
      .map(v => `${v.hotel?.name || ''}|${v.checkIn ? new Date(v.checkIn).toISOString().slice(0, 10) : ''}`)
  );

  const segments = groups.map(g => {
    const checkIn = addDays(quote.startDate, g.firstDay - 1);
    const checkOut = addDays(quote.startDate, g.lastDay);
    const key = `${g.name}|${checkIn.toISOString().slice(0, 10)}`;
    return {
      hotelId: g.hotelId,
      hotel: {
        name: g.name,
        location: g.location,
        contactEmail: g.contactEmail,
        contactPhone: g.contactPhone,
      },
      roomType: g.roomType,
      mealPlan: g.mealPlan,
      checkIn,
      checkOut,
      nights: g.nights,
      alreadyExists: existingKeys.has(key),
    };
  });

  return { segments };
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
// after adding a stop is safe).
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

    const existing = await Voucher.find({
      organization: req.organizationId,
      deal: quote.deal,
    }).select('hotel checkIn status').lean();

    const { segments, error } = await previewVouchersFromQuote(quote, existing);
    if (error) return res.status(400).json({ message: error });

    // Snapshot the lead guest from the deal's contact (same defaulting logic
    // as the manual create route).
    const guest = {
      name: deal.contact ? `${deal.contact.firstName || ''} ${deal.contact.lastName || ''}`.trim() : '',
      email: deal.contact?.email || '',
      phone: deal.contact?.phone || '',
    };
    const adults = quote.travelers?.adults || deal.groupSize || 1;
    const children = quote.travelers?.children || 0;

    const created = [];
    const failed = [];
    let skipped = 0;
    for (const seg of segments) {
      if (seg.alreadyExists) { skipped++; continue; }
      try {
        const voucher = await Voucher.create({
          organization: req.organizationId,
          deal: deal._id,
          contact: deal.contact?._id || null,
          quote: quote._id,
          createdBy: req.user._id,
          voucherNumber: await nextVoucherNumber(req.organizationId),
          hotelRef: seg.hotelId || null,
          hotel: seg.hotel,
          guest,
          adults,
          children,
          checkIn: seg.checkIn,
          checkOut: seg.checkOut,
          roomType: seg.roomType,
          rooms: 1,
          mealPlan: seg.mealPlan,
        });
        created.push(voucher);
      } catch (err) {
        // Most likely cause is the unique-index race on voucherNumber, which
        // is recoverable on a manual retry. Continue the batch so partial
        // success still ships, but surface the failures in the response.
        console.error('Voucher generate failed one segment:', err.message);
        failed.push({ hotel: seg.hotel?.name || 'unknown', message: err.message });
      }
    }

    // If every attempt failed, this isn't a partial success — return 500 with
    // the first error so the operator knows something is actually broken.
    const attempts = segments.length - skipped;
    if (attempts > 0 && created.length === 0) {
      return res.status(500).json({
        message: failed[0]?.message || 'Failed to generate vouchers',
        failed,
      });
    }

    res.status(201).json({
      created,
      skipped,
      failed,
      total: segments.length,
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
