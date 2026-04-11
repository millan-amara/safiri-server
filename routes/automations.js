import { Router } from 'express';
import Automation from '../models/Automation.js';
import AUTOMATION_TEMPLATES from '../automations/templates.js';
import { protect, authorize } from '../middleware/auth.js';

const router = Router();

// GET templates
router.get('/templates', protect, (req, res) => {
  res.json({ templates: AUTOMATION_TEMPLATES });
});

// GET all automations for org
router.get('/', protect, async (req, res) => {
  try {
    const automations = await Automation.find({ organization: req.organizationId })
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 });
    res.json({ automations });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET single
router.get('/:id', protect, async (req, res) => {
  try {
    const automation = await Automation.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!automation) return res.status(404).json({ message: 'Not found' });
    res.json({ automation });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// CREATE — from template or custom
router.post('/', protect, async (req, res) => {
  try {
    const { templateId, ...body } = req.body;
    let automationData = { ...body, organization: req.organizationId, createdBy: req.user._id };

    if (templateId) {
      const template = AUTOMATION_TEMPLATES.find(t => t.id === templateId);
      if (!template) return res.status(404).json({ message: 'Template not found' });

      automationData = {
        ...automationData,
        templateId,
        name: body.name || template.name,
        description: body.description || template.description,
        trigger: body.trigger || template.trigger,
        conditions: body.conditions || template.conditions,
        actions: body.actions || template.actions,
      };
    }

    const automation = await Automation.create(automationData);
    res.status(201).json({ automation });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// UPDATE
router.put('/:id', protect, async (req, res) => {
  try {
    const automation = await Automation.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!automation) return res.status(404).json({ message: 'Not found' });
    res.json({ automation });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// TOGGLE active/inactive
router.patch('/:id/toggle', protect, async (req, res) => {
  try {
    const automation = await Automation.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!automation) return res.status(404).json({ message: 'Not found' });
    automation.isActive = !automation.isActive;
    await automation.save();
    res.json({ automation });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// DELETE
router.delete('/:id', protect, async (req, res) => {
  try {
    await Automation.findOneAndDelete({ _id: req.params.id, organization: req.organizationId });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;