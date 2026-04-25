import { Router } from 'express';
import SavedView from '../models/SavedView.js';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';

const router = Router();

// Persist the user's last-applied view so the next CRM-page mount can
// auto-restore it. `viewId: null` means "operator cleared back to defaults".
router.put('/preference', protect, async (req, res) => {
  try {
    const { viewId = null } = req.body;
    await User.findByIdAndUpdate(req.user._id, { lastPipelineViewId: viewId });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// LIST current user's saved views (optionally narrowed by scope).
router.get('/', protect, async (req, res) => {
  try {
    const filter = { user: req.user._id, organization: req.organizationId };
    if (req.query.scope) filter.scope = req.query.scope;
    const views = await SavedView.find(filter).sort({ createdAt: 1 });
    res.json({ views });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// CREATE a new saved view from the current filter state.
router.post('/', protect, async (req, res) => {
  try {
    const { name, scope = 'pipeline', filters = {} } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'name is required' });
    const view = await SavedView.create({
      organization: req.organizationId,
      user: req.user._id,
      name: name.trim(),
      scope,
      filters,
    });
    res.status(201).json(view);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// UPDATE name and/or filters of an existing view (owner only).
router.put('/:id', protect, async (req, res) => {
  try {
    const view = await SavedView.findOne({
      _id: req.params.id,
      user: req.user._id,
      organization: req.organizationId,
    });
    if (!view) return res.status(404).json({ message: 'Not found' });
    if (typeof req.body.name === 'string' && req.body.name.trim()) {
      view.name = req.body.name.trim();
    }
    if (req.body.filters) view.filters = req.body.filters;
    await view.save();
    res.json(view);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/:id', protect, async (req, res) => {
  try {
    const result = await SavedView.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
      organization: req.organizationId,
    });
    if (!result) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
