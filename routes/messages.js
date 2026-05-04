import { Router } from 'express';
import { Deal, Pipeline } from '../models/Deal.js';
import Voucher from '../models/Voucher.js';
import Organization from '../models/Organization.js';
import { protect, authorize } from '../middleware/auth.js';
import { userCanSeePipeline } from '../middleware/access.js';
import { sendEmail, operatorSenderName } from '../utils/email.js';
import { buildVoucherPdf, fmtVoucherNumber } from '../services/voucherPdf.js';
import {
  buildTemplateContext,
  renderTemplate,
  listTemplates,
  bodyToHtml,
} from '../services/messageTemplates.js';

const router = Router();

// Pipeline-access gating, mirroring the pattern in routes/vouchers.js.
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
  return { deal };
}

// LIST templates — for the client picker.
router.get('/templates', protect, (req, res) => {
  res.json({ templates: listTemplates() });
});

// PREVIEW a rendered template with a deal's context. Used by the modal so the
// operator can see the substituted subject/body before they edit.
router.get('/templates/:key/preview', protect, async (req, res) => {
  try {
    const { dealId } = req.query;
    if (!dealId) return res.status(400).json({ message: 'dealId is required' });
    const { deal, error } = await loadAccessibleDeal(req, dealId);
    if (error) return res.status(error.status).json({ message: error.message });

    const org = await Organization.findById(req.organizationId).lean();
    const ctx = buildTemplateContext({
      deal,
      contact: deal.contact,
      org,
      user: req.user,
    });
    const rendered = renderTemplate(req.params.key, ctx);
    if (!rendered) return res.status(404).json({ message: 'Unknown template' });
    res.json(rendered);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// SEND — the main action. `templateKey` is informational/audit only; the
// subject + body the operator typed are what actually get sent. (Server-side
// re-render would discard their edits.) `attachVoucherId` optionally pulls
// the voucher PDF and attaches it.
router.post('/send', protect, authorize('owner', 'admin', 'agent'), async (req, res) => {
  try {
    const {
      dealId, templateKey,
      to, cc,
      subject, body,
      attachVoucherId,
    } = req.body;

    if (!dealId) return res.status(400).json({ message: 'dealId is required' });
    if (!subject?.trim()) return res.status(400).json({ message: 'Subject is required' });
    if (!body?.trim()) return res.status(400).json({ message: 'Body is required' });

    const recipients = Array.isArray(to)
      ? to
      : String(to || '').split(',').map(s => s.trim()).filter(Boolean);
    if (recipients.length === 0) {
      return res.status(400).json({ message: 'At least one recipient is required.' });
    }

    const ccList = Array.isArray(cc)
      ? cc
      : String(cc || '').split(',').map(s => s.trim()).filter(Boolean);

    const { deal, error } = await loadAccessibleDeal(req, dealId);
    if (error) return res.status(error.status).json({ message: error.message });

    // Loaded for both senderName (always) and the optional voucher PDF render.
    const org = await Organization.findById(req.organizationId).lean();

    // Optional voucher attachment. Scoped by org so a tampered ID can't pull
    // a foreign-tenant voucher PDF.
    let attachments;
    if (attachVoucherId) {
      const voucher = await Voucher.findOne({
        _id: attachVoucherId,
        organization: req.organizationId,
      });
      if (voucher) {
        const pdf = await buildVoucherPdf(voucher, org);
        attachments = [{
          filename: `${fmtVoucherNumber(voucher.voucherNumber)}.pdf`,
          content: pdf,
          contentType: 'application/pdf',
        }];
      }
    }

    // Send. Reply-To = operator's email so client replies land in their
    // actual inbox, not the noreply mailbox the CRM sends from.
    // senderName customises the From display so the recipient sees the
    // operator's brand, not "SafiriPro <noreply@...>".
    await sendEmail({
      to: ccList.length ? [...recipients, ...ccList] : recipients,
      subject,
      html: bodyToHtml(body),
      replyTo: req.user.email,
      senderName: operatorSenderName({ user: req.user, org }),
      attachments,
    });

    // Append to the deal's activity timeline. metadata stores the full send
    // for audit — recipient list, template used, body length.
    deal.activities.push({
      type: 'email_sent',
      description: `${req.user.name || 'Operator'} sent "${subject}" to ${recipients.join(', ')}`,
      createdBy: req.user._id,
      createdAt: new Date(),
      metadata: {
        templateKey: templateKey || 'custom',
        to: recipients,
        cc: ccList,
        subject,
        bodyPreview: body.slice(0, 200),
        attachedVoucher: attachVoucherId || null,
      },
    });
    await deal.save();

    res.json({ message: 'Email sent', recipients });
  } catch (error) {
    console.error('Email send failed:', error.message);
    res.status(500).json({ message: error.message });
  }
});

export default router;
