import { Router } from 'express';
import Destination from '../models/Destination.js';
import { protect } from '../middleware/auth.js';
import { requirePartnerQuota, enforceImageCap } from '../middleware/partnerQuota.js';

const router = Router();

// List destinations for this org
router.get('/', protect, async (req, res) => {
  try {
    const { search, type } = req.query;
    const filter = { organization: req.organizationId, isActive: true };
    if (search) filter.name = { $regex: new RegExp(search, 'i') };
    if (type) filter.type = type;

    const destinations = await Destination.find(filter).sort({ name: 1 });
    res.json({ destinations });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get single (scoped)
router.get('/:id', protect, async (req, res) => {
  try {
    const dest = await Destination.findOne({ _id: req.params.id, organization: req.organizationId })
      .populate('nearbyDestinations.destination', 'name');
    if (!dest) return res.status(404).json({ message: 'Not found' });
    res.json(dest);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create
router.post('/', protect, requirePartnerQuota('destination'), enforceImageCap, async (req, res) => {
  try {
    const dest = await Destination.create({ ...req.body, organization: req.organizationId });
    res.status(201).json(dest);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update
router.put('/:id', protect, enforceImageCap, async (req, res) => {
  try {
    const dest = await Destination.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      req.body,
      { new: true }
    );
    if (!dest) return res.status(404).json({ message: 'Not found' });
    res.json(dest);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Add image
router.post('/:id/images', protect, async (req, res) => {
  try {
    const { url, caption, isHero, credit } = req.body;
    const dest = await Destination.findOne({ _id: req.params.id, organization: req.organizationId });
    if (!dest) return res.status(404).json({ message: 'Not found' });

    dest.images.push({ url, caption: caption || '', isHero: !!isHero, credit: credit || '' });
    await dest.save();
    res.json(dest);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Remove image
router.delete('/:id/images', protect, async (req, res) => {
  try {
    await Destination.findOneAndUpdate(
      { _id: req.params.id, organization: req.organizationId },
      { $pull: { images: { url: req.body.imageUrl } } }
    );
    res.json({ message: 'Removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get images by destination name (for quote builder fallback)
router.get('/by-name/:name/images', protect, async (req, res) => {
  try {
    const dest = await Destination.findOne({
      organization: req.organizationId,
      name: { $regex: new RegExp(req.params.name, 'i') },
      isActive: true,
    }).select('images name');
    res.json({ images: dest?.images || [], name: dest?.name || req.params.name });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;