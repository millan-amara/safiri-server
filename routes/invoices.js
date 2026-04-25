import { Router } from 'express';
import Invoice from '../models/Invoice.js';
import { Deal, Pipeline } from '../models/Deal.js';
import Organization from '../models/Organization.js';
import { protect, authorize } from '../middleware/auth.js';
import { userCanSeePipeline, getAccessiblePipelineIds } from '../middleware/access.js';
import { buildInvoicePayloadFromDeal, nextInvoiceNumber } from '../services/invoiceBuilder.js';
import { buildInvoicePdf, fmtInvoiceNumber } from '../services/invoicePdf.js';
import { fireInvoiceWebhook } from '../services/invoiceWebhook.js';

const router = Router();

const ADMIN_ROLES = ['owner', 'admin'];
const isAdmin = (user) => ADMIN_ROLES.includes(user.role);

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

// Verify the current user can read/write an invoice (via pipeline access on its deal).
async function loadAccessibleInvoice(req, invoiceId) {
  const invoice = await Invoice.findOne({ _id: invoiceId, organization: req.organizationId });
  if (!invoice) return { error: { status: 404, message: 'Invoice not found' } };
  const { deal, error } = await loadAccessibleDeal(req, invoice.deal);
  if (error) return { error };
  return { invoice, deal };
}

// LIST — for the per-deal panel (?deal=) or the top-level Invoices page (?status=, paginated)
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

    const invoices = await Invoice.find(filter)
      .populate('deal', 'title')
      .populate('createdBy', 'name avatar')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await Invoice.countDocuments(filter);
    res.json({ invoices, total });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// READ
router.get('/:id', protect, async (req, res) => {
  try {
    const { invoice, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// CREATE — generate from deal (manual button on per-deal panel)
router.post('/', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { dealId, taxPercent, dueDate } = req.body;
    if (!dealId) return res.status(400).json({ message: 'dealId is required' });

    const { deal, error } = await loadAccessibleDeal(req, dealId);
    if (error) return res.status(error.status).json({ message: error.message });

    const org = await Organization.findById(req.organizationId).lean();
    const payload = await buildInvoicePayloadFromDeal({
      deal,
      org,
      taxPercentOverride: typeof taxPercent === 'number' ? taxPercent : undefined,
      dueDateOverride: dueDate ? new Date(dueDate) : null,
    });
    payload.invoiceNumber = await nextInvoiceNumber(req.organizationId);
    payload.createdBy = req.user._id;

    const invoice = await Invoice.create(payload);
    fireInvoiceWebhook('invoice.created', invoice);
    res.status(201).json(invoice);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Invoice number collision — please retry' });
    }
    res.status(500).json({ message: error.message });
  }
});

// UPDATE — only while draft (sent/paid invoices are immutable for audit)
router.put('/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { invoice, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (invoice.status !== 'draft') {
      return res.status(400).json({ message: 'Only draft invoices can be edited.' });
    }

    const editable = ['client', 'dueDate', 'lineItems', 'taxPercent', 'currency', 'paymentInstructions', 'notes'];
    for (const f of editable) {
      if (f in req.body) invoice[f] = req.body[f];
    }
    // Recompute totals on edit so the operator can't accidentally save inconsistent numbers.
    invoice.subtotal = (invoice.lineItems || []).reduce((s, li) => s + (Number(li.total) || 0), 0);
    invoice.taxAmount = Math.round(invoice.subtotal * ((Number(invoice.taxPercent) || 0) / 100) * 100) / 100;
    invoice.total = invoice.subtotal + invoice.taxAmount;

    await invoice.save();
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// MARK SENT
router.post('/:id/mark-sent', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { invoice, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (!['draft', 'cancelled'].includes(invoice.status)) {
      return res.status(400).json({ message: 'Only draft invoices can be marked as sent.' });
    }
    invoice.status = 'sent';
    invoice.sentAt = new Date();
    await invoice.save();
    fireInvoiceWebhook('invoice.sent', invoice);
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// MARK PAID
router.post('/:id/mark-paid', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { invoice, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (invoice.status === 'cancelled') {
      return res.status(400).json({ message: 'Cancelled invoices cannot be marked paid — uncancel first.' });
    }
    invoice.status = 'paid';
    invoice.paidAt = new Date();
    await invoice.save();
    fireInvoiceWebhook('invoice.paid', invoice);
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// CANCEL
router.post('/:id/cancel', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { invoice, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (invoice.status === 'paid') {
      return res.status(400).json({ message: 'Paid invoices cannot be cancelled.' });
    }
    invoice.status = 'cancelled';
    await invoice.save();
    fireInvoiceWebhook('invoice.cancelled', invoice);
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// DELETE — drafts only; sent/paid stay for audit
router.delete('/:id', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { invoice, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (invoice.status !== 'draft' && invoice.status !== 'cancelled') {
      return res.status(400).json({ message: 'Only draft or cancelled invoices can be deleted.' });
    }
    await Invoice.findByIdAndDelete(invoice._id);
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// CSV export for accountant handoff. Filters by date range (issueDate),
// status, and search; respects pipeline access for non-admins. Returns a
// streamable string response with Content-Disposition: attachment.
router.get('/export.csv', protect, async (req, res) => {
  try {
    const { from, to, status, search } = req.query;
    const filter = { organization: req.organizationId };

    if (status && status !== 'all') filter.status = status;
    if (from || to) {
      filter.issueDate = {};
      if (from) filter.issueDate.$gte = new Date(from);
      if (to) filter.issueDate.$lte = new Date(to);
    }
    if (!isAdmin(req.user)) {
      const accessiblePipelines = await getAccessiblePipelineIds(req.user);
      const accessibleDeals = await Deal.find({
        organization: req.organizationId,
        pipeline: { $in: accessiblePipelines },
        isActive: true,
      }).select('_id').lean();
      filter.deal = { $in: accessibleDeals.map(d => d._id) };
    }

    const invoices = await Invoice.find(filter)
      .populate('deal', 'title')
      .sort({ invoiceNumber: 1 })
      .lean();

    // Optional client-side-style search filter on top of the DB query.
    const filtered = search
      ? invoices.filter(inv => {
          const hay = [
            fmtInvoiceNumber(inv.invoiceNumber),
            inv.client?.name, inv.client?.company, inv.client?.email,
            inv.deal?.title,
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(String(search).toLowerCase());
        })
      : invoices;

    const headers = [
      'Invoice Number', 'Status', 'Issued', 'Due', 'Sent', 'Paid',
      'Client Name', 'Client Company', 'Client Email', 'Client Phone',
      'Deal', 'Currency', 'Subtotal', 'Tax %', 'Tax Amount', 'Total',
      'Notes',
    ];

    const isoDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';
    const rows = filtered.map(inv => [
      fmtInvoiceNumber(inv.invoiceNumber),
      inv.status,
      isoDate(inv.issueDate),
      isoDate(inv.dueDate),
      isoDate(inv.sentAt),
      isoDate(inv.paidAt),
      inv.client?.name || '',
      inv.client?.company || '',
      inv.client?.email || '',
      inv.client?.phone || '',
      inv.deal?.title || '',
      inv.currency || '',
      Number(inv.subtotal || 0).toFixed(2),
      Number(inv.taxPercent || 0).toFixed(2),
      Number(inv.taxAmount || 0).toFixed(2),
      Number(inv.total || 0).toFixed(2),
      inv.notes || '',
    ]);

    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');

    const filename = `invoices-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + csv); // BOM so Excel detects UTF-8 correctly
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// PDF download — inline so browsers preview, but a Save dialog still works.
router.get('/:id/pdf', protect, async (req, res) => {
  try {
    const { invoice, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    const org = await Organization.findById(req.organizationId).lean();
    const pdfBuffer = await buildInvoicePdf(invoice, org);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fmtInvoiceNumber(invoice.invoiceNumber)}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Invoice PDF generation failed:', error.message);
    res.status(500).json({ message: error.message });
  }
});

export default router;
