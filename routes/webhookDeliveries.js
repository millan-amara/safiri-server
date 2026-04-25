import { Router } from 'express';
import WebhookDelivery from '../models/WebhookDelivery.js';
import { protect, authorize } from '../middleware/auth.js';
import { processDelivery } from '../services/invoiceWebhook.js';

const router = Router();

// LIST recent deliveries for the operator's org. Owner/admin only — webhook
// configuration is admin-managed, so the delivery log shouldn't leak to agents.
router.get('/', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    const { status, event, limit = 50 } = req.query;
    const filter = { organization: req.organizationId };
    if (status && status !== 'all') filter.status = status;
    if (event) filter.event = event;

    const deliveries = await WebhookDelivery.find(filter)
      .populate('relatedInvoice', 'invoiceNumber total currency')
      .sort({ createdAt: -1 })
      .limit(Math.min(parseInt(limit) || 50, 200));
    res.json({ deliveries });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// MANUAL RETRY — synchronous; resets attempts? No, just runs another one
// (preserves the attempts counter so the operator sees the full history).
// Allowed for any non-succeeded delivery; if it's already at maxAttempts we
// bump maxAttempts by 1 so processDelivery doesn't immediately mark it failed.
router.post('/:id/retry', protect, authorize('owner', 'admin'), async (req, res) => {
  try {
    const delivery = await WebhookDelivery.findOne({
      _id: req.params.id,
      organization: req.organizationId,
    });
    if (!delivery) return res.status(404).json({ message: 'Not found' });
    if (delivery.status === 'succeeded') {
      return res.status(400).json({ message: 'Already delivered.' });
    }

    if (delivery.attempts >= delivery.maxAttempts) {
      delivery.maxAttempts = delivery.attempts + 1;
    }
    delivery.status = 'pending';
    delivery.nextAttemptAt = new Date();
    await delivery.save();

    const updated = await processDelivery(delivery);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
