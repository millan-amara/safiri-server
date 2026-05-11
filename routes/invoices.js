import { Router } from 'express';
import Invoice from '../models/Invoice.js';
import { Deal, Pipeline } from '../models/Deal.js';
import Organization from '../models/Organization.js';
import { protect, authorize } from '../middleware/auth.js';
import { userCanSeePipeline, getAccessiblePipelineIds } from '../middleware/access.js';
import {
  buildInvoicePayloadFromDeal,
  buildDepositBalancePayloadsFromDeal,
  nextInvoiceNumber,
} from '../services/invoiceBuilder.js';
import { buildInvoicePdf, fmtInvoiceNumber } from '../services/invoicePdf.js';
import { fireInvoiceWebhook } from '../services/invoiceWebhook.js';
import { sendEmail, operatorSenderName, invoiceEmail } from '../utils/email.js';

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

// SPLIT — generate paired deposit + balance drafts from a deal in one click.
// Reuses the standard payload builder for client snapshot / line items, then
// derives two slices with proportional totals and travel-aware due dates.
router.post('/split', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const {
      dealId,
      depositPercent,
      depositDueDays,
      balanceDaysBeforeTravel,
      taxPercent,
    } = req.body;
    if (!dealId) return res.status(400).json({ message: 'dealId is required' });

    const { deal, error } = await loadAccessibleDeal(req, dealId);
    if (error) return res.status(error.status).json({ message: error.message });

    const org = await Organization.findById(req.organizationId).lean();
    const { deposit, balance } = await buildDepositBalancePayloadsFromDeal({
      deal,
      org,
      depositPercent,
      depositDueDays: typeof depositDueDays === 'number' ? depositDueDays : undefined,
      balanceDaysBeforeTravel: typeof balanceDaysBeforeTravel === 'number' ? balanceDaysBeforeTravel : undefined,
      taxPercentOverride: typeof taxPercent === 'number' ? taxPercent : undefined,
    });

    if (!(deposit.subtotal > 0) && !(balance.subtotal > 0)) {
      return res.status(400).json({ message: 'No quote total or deal value to split.' });
    }

    deposit.invoiceNumber = await nextInvoiceNumber(req.organizationId);
    deposit.createdBy = req.user._id;
    const depositInv = await Invoice.create(deposit);

    // Take a fresh number AFTER the deposit insert so the second one wins on
    // a concurrent insert race instead of colliding on the unique index.
    balance.invoiceNumber = await nextInvoiceNumber(req.organizationId);
    balance.createdBy = req.user._id;
    balance.relatedInvoice = depositInv._id;
    const balanceInv = await Invoice.create(balance);

    // Backfill the deposit → balance link now that we have the balance id.
    depositInv.relatedInvoice = balanceInv._id;
    await depositInv.save();

    fireInvoiceWebhook('invoice.created', depositInv);
    fireInvoiceWebhook('invoice.created', balanceInv);

    res.status(201).json({ deposit: depositInv, balance: balanceInv });
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

const PAYMENT_METHODS = ['cash', 'bank_transfer', 'mpesa', 'card', 'other'];

const PAYMENT_METHOD_LABEL = {
  cash:          'cash',
  bank_transfer: 'bank transfer',
  mpesa:         'M-Pesa',
  card:          'card',
  other:         'other',
};

// Format an amount with currency. Used in deal activity descriptions so the
// timeline reads naturally without requiring a UI lookup.
function fmtAmount(amount, currency) {
  return `${currency || 'USD'} ${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// MARK PAID — shorthand for "client paid the remaining balance, however".
// Funnels through payments[] so the audit trail captures who/when/method
// instead of just a status flip. Optional body fields override the defaults.
router.post('/:id/mark-paid', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { invoice, deal, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (invoice.status === 'cancelled') {
      return res.status(400).json({ message: 'Cancelled invoices cannot be marked paid — uncancel first.' });
    }
    if (invoice.status === 'paid') {
      return res.json(invoice);
    }

    const remaining = Math.max(0, Math.round(((Number(invoice.total) || 0) - invoice.amountPaid) * 100) / 100);
    if (remaining > 0) {
      invoice.payments.push({
        amount: remaining,
        currency: invoice.currency,
        method: PAYMENT_METHODS.includes(req.body?.method) ? req.body.method : 'other',
        reference: req.body?.reference || '',
        paidAt: req.body?.paidAt ? new Date(req.body.paidAt) : new Date(),
        notes: req.body?.notes || 'Marked paid by operator',
        recordedBy: req.user._id,
        source: 'manual',
      });
    }

    const { becamePaid } = invoice.applyPaymentsRecompute();
    await invoice.save();
    if (becamePaid) fireInvoiceWebhook('invoice.paid', invoice);

    if (remaining > 0) {
      deal.activities.push({
        type: 'payment_recorded',
        description: `${req.user.name || 'Operator'} marked ${fmtInvoiceNumber(invoice.invoiceNumber)} paid (${fmtAmount(remaining, invoice.currency)})`,
        createdBy: req.user._id,
        createdAt: new Date(),
        metadata: { invoiceId: invoice._id, amount: remaining, source: 'mark_paid' },
      });
      await deal.save();
    }

    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// LOG PAYMENT — append one payment row. Status auto-recomputes:
//   sum < total  → partially_paid
//   sum >= total → paid (fires invoice.paid webhook on the actual transition)
// Cancelled invoices reject; over-payment rejects (no implicit refunds).
router.post('/:id/payments', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { invoice, deal, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (invoice.status === 'cancelled') {
      return res.status(400).json({ message: 'Cancelled invoices cannot accept payments.' });
    }

    const { amount, method, reference, paidAt, notes } = req.body || {};
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ message: 'amount must be a positive number.' });
    }

    const due = Math.max(0, Math.round(((Number(invoice.total) || 0) - invoice.amountPaid) * 100) / 100);
    if (due === 0) {
      return res.status(400).json({ message: 'Invoice is already fully paid.' });
    }
    // Allow a 1-cent tolerance so floating-point rounding doesn't reject a
    // payment that exactly matches the displayed balance.
    if (amt > due + 0.01) {
      return res.status(400).json({ message: `Amount exceeds outstanding balance of ${due.toFixed(2)} ${invoice.currency}.` });
    }

    const chosenMethod = PAYMENT_METHODS.includes(method) ? method : 'other';
    invoice.payments.push({
      amount: amt,
      currency: invoice.currency,
      method: chosenMethod,
      reference: reference || '',
      paidAt: paidAt ? new Date(paidAt) : new Date(),
      notes: notes || '',
      recordedBy: req.user._id,
      source: 'manual',
    });

    const { becamePaid } = invoice.applyPaymentsRecompute();
    await invoice.save();
    if (becamePaid) fireInvoiceWebhook('invoice.paid', invoice);

    const refSuffix = reference ? `, ref ${reference}` : '';
    deal.activities.push({
      type: 'payment_recorded',
      description: `${req.user.name || 'Operator'} recorded ${fmtAmount(amt, invoice.currency)} payment on ${fmtInvoiceNumber(invoice.invoiceNumber)} via ${PAYMENT_METHOD_LABEL[chosenMethod]}${refSuffix}`,
      createdBy: req.user._id,
      createdAt: new Date(),
      metadata: {
        invoiceId: invoice._id,
        amount: amt,
        method: chosenMethod,
        reference: reference || '',
        becamePaid,
      },
    });
    await deal.save();

    res.status(201).json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// REMOVE PAYMENT — owner/admin only since it corrects bookkeeping. Status
// auto-recomputes (paid → partially_paid → sent as the array empties out).
// Doesn't fire a webhook on the demotion — consumers should reconcile from
// the next invoice.paid event or fetch state directly if they need to track
// reversals.
router.delete('/:id/payments/:paymentId', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    const { invoice, deal, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });

    const payment = invoice.payments.id(req.params.paymentId);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });

    // Snapshot before pull so we can describe what was removed in the activity log.
    const removedAmount = payment.amount;
    const removedMethod = payment.method;
    const removedRef = payment.reference;

    invoice.payments.pull({ _id: req.params.paymentId });
    invoice.applyPaymentsRecompute();
    await invoice.save();

    const refSuffix = removedRef ? `, ref ${removedRef}` : '';
    deal.activities.push({
      type: 'payment_removed',
      description: `${req.user.name || 'Operator'} removed ${fmtAmount(removedAmount, invoice.currency)} payment from ${fmtInvoiceNumber(invoice.invoiceNumber)} (${PAYMENT_METHOD_LABEL[removedMethod] || removedMethod}${refSuffix})`,
      createdBy: req.user._id,
      createdAt: new Date(),
      metadata: {
        invoiceId: invoice._id,
        amount: removedAmount,
        method: removedMethod,
        reference: removedRef || '',
      },
    });
    await deal.save();

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
      'Amount Paid', 'Amount Due', 'Payments',
      'Notes',
    ];

    const isoDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';
    const rows = filtered.map(inv => {
      // Compute amountPaid/amountDue manually since lean() docs don't include
      // virtuals. Also flatten payments into a semicolon-joined column for
      // bank reconciliation — accountants want refs visible at-a-glance
      // without opening the deal.
      const payments = inv.payments || [];
      const amountPaid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const amountDue = Math.max(0, (Number(inv.total) || 0) - amountPaid);
      const paymentsCol = payments
        .map(p => {
          const date = isoDate(p.paidAt);
          const amt = Number(p.amount || 0).toFixed(2);
          const method = p.method || '';
          const ref = p.reference || '';
          return [date, method, amt, ref].filter(Boolean).join(' ');
        })
        .join('; ');

      return [
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
        amountPaid.toFixed(2),
        amountDue.toFixed(2),
        paymentsCol,
        inv.notes || '',
      ];
    });

    // Cells starting with =, +, -, @, tab, or CR are interpreted as formulas
    // by Excel/Sheets when the CSV is opened. A deal title like
    //   =cmd|'/c calc'!A0
    // would execute on the accountant's machine. Prefix with a single quote
    // (the Excel "this is a literal string" convention) to neutralize.
    const formulaSafe = (s) => /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = formulaSafe(String(v));
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

// EMAIL — sends the PDF as an attachment, flips draft → sent on success, and
// logs to the deal's activity timeline. Mirrors the voucher email pattern.
router.post('/:id/email', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const { invoice, deal, error } = await loadAccessibleInvoice(req, req.params.id);
    if (error) return res.status(error.status).json({ message: error.message });
    if (invoice.status === 'cancelled') {
      return res.status(400).json({ message: 'Cancelled invoices cannot be emailed.' });
    }

    const recipients = Array.isArray(req.body.to)
      ? req.body.to
      : String(req.body.to || '').split(',').map(s => s.trim()).filter(Boolean);
    if (recipients.length === 0) {
      return res.status(400).json({ message: 'At least one recipient is required.' });
    }
    const ccList = Array.isArray(req.body.cc)
      ? req.body.cc
      : String(req.body.cc || '').split(',').map(s => s.trim()).filter(Boolean);

    const org = await Organization.findById(req.organizationId).lean();
    const pdfBuffer = await buildInvoicePdf(invoice, org);
    const filename = `${fmtInvoiceNumber(invoice.invoiceNumber)}.pdf`;

    const html = invoiceEmail({
      clientName: invoice.client?.name,
      invoiceNumber: fmtInvoiceNumber(invoice.invoiceNumber),
      total: invoice.total,
      currency: invoice.currency,
      dueDate: invoice.dueDate,
      paymentInstructions: invoice.paymentInstructions,
      orgName: org?.name,
      message: req.body.message || '',
      type: invoice.type || 'full',
      // Virtuals on the hydrated doc — let the template re-frame the email
      // as "balance reminder" or "receipt" when payments have been recorded.
      amountPaid: invoice.amountPaid,
      amountDue: invoice.amountDue,
    });

    // Subject auto-reframes for partial / paid-in-full sends so the inbox
    // preview reflects what's actually in the email.
    const subjectPrefix = invoice.status === 'paid' ? 'Receipt'
      : invoice.amountPaid > 0 ? 'Balance reminder'
      : invoice.type === 'deposit' ? 'Deposit invoice'
      : invoice.type === 'balance' ? 'Balance invoice'
      : 'Invoice';

    await sendEmail({
      to: ccList.length ? [...recipients, ...ccList] : recipients,
      subject: req.body.subject || `${subjectPrefix} ${fmtInvoiceNumber(invoice.invoiceNumber)} — ${deal.title || ''}`.trim(),
      html,
      replyTo: req.user.email,
      senderName: operatorSenderName({ user: req.user, org }),
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
    });

    // Auto-flip draft → sent. The operator just sent it; clicking "Mark sent"
    // afterwards is friction we don't need.
    if (invoice.status === 'draft') {
      invoice.status = 'sent';
      invoice.sentAt = new Date();
      await invoice.save();
      fireInvoiceWebhook('invoice.sent', invoice);
    }

    // Log to the deal timeline so the activity history shows when each
    // invoice was sent and to whom.
    deal.activities.push({
      type: 'email_sent',
      description: `${req.user.name || 'Operator'} emailed ${fmtInvoiceNumber(invoice.invoiceNumber)} to ${recipients.join(', ')}`,
      createdBy: req.user._id,
      createdAt: new Date(),
      metadata: {
        templateKey: 'invoice',
        invoiceId: invoice._id,
        to: recipients,
        cc: ccList,
      },
    });
    await deal.save();

    res.json(invoice);
  } catch (error) {
    console.error('Invoice email failed:', error.message);
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
