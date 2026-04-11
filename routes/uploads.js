import { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { protect } from '../middleware/auth.js';
import Hotel from '../models/Hotel.js';
import Activity from '../models/Activity.js';
import Transport from '../models/Transport.js';
import Organization from '../models/Organization.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Configure cloudinary
const configureCloudinary = () => {
  if (process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    return true;
  }
  return false;
};

// Upload to cloudinary helper
const uploadToCloudinary = (buffer, folder) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `safari-crm/${folder}`, resource_type: 'auto', quality: 'auto', fetch_format: 'auto' },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
};

// ─── UPLOAD IMAGE TO ENTITY ──────────────────────

router.post('/image', protect, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const { entityType, entityId, caption, isHero } = req.body;

    if (!configureCloudinary()) {
      // Fallback: return a data URL for development
      const base64 = req.file.buffer.toString('base64');
      const dataUrl = `data:${req.file.mimetype};base64,${base64}`;
      return res.json({ url: dataUrl, caption: caption || '', message: 'Cloudinary not configured — using base64 fallback' });
    }

    const folder = `${req.organizationId}/${entityType}`;
    const result = await uploadToCloudinary(req.file.buffer, folder);
    const imageData = { url: result.secure_url, caption: caption || '' };

    // Attach to entity
    if (entityType === 'hotel' && entityId) {
      await Hotel.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $push: { images: { ...imageData, isHero: isHero === 'true' } } }
      );
    } else if (entityType === 'activity' && entityId) {
      await Activity.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $push: { images: imageData } }
      );
    } else if (entityType === 'transport' && entityId) {
      await Transport.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $push: { images: imageData } }
      );
    } else if (entityType === 'destination' && entityId) {
      const Destination = (await import('../models/Destination.js')).default;
      await Destination.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $push: { images: { ...imageData, isHero: isHero === 'true', credit: '' } } }
      );
    }

    res.json({ url: result.secure_url, publicId: result.public_id, caption });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── UPLOAD LOGO ────────────────────────────────

router.post('/logo', protect, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    let logoUrl;
    if (configureCloudinary()) {
      const result = await uploadToCloudinary(req.file.buffer, `${req.organizationId}/branding`);
      logoUrl = result.secure_url;
    } else {
      logoUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }

    await Organization.findByIdAndUpdate(req.organizationId, { 'branding.logo': logoUrl });
    res.json({ url: logoUrl });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── DELETE IMAGE ───────────────────────────────

router.delete('/image', protect, async (req, res) => {
  try {
    const { entityType, entityId, imageUrl } = req.body;

    if (entityType === 'hotel') {
      await Hotel.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $pull: { images: { url: imageUrl } } }
      );
    } else if (entityType === 'activity') {
      await Activity.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $pull: { images: { url: imageUrl } } }
      );
    } else if (entityType === 'destination') {
      const Destination = (await import('../models/Destination.js')).default;
      await Destination.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $pull: { images: { url: imageUrl } } }
      );
    }

    // Optionally delete from Cloudinary too
    // if (configureCloudinary()) { cloudinary.uploader.destroy(publicId); }

    res.json({ message: 'Image removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── CONTACT CSV IMPORT (with AI column mapping) ─

router.post('/contacts-csv', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    // Parse CSV
    const text = req.file.buffer.toString('utf-8');
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ message: 'CSV must have headers and at least one row' });

    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const rows = lines.slice(1, 4).map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
      const obj = {};
      headers.forEach((h, i) => obj[h] = vals[i] || '');
      return obj;
    });

    // Return headers + sample for AI mapping preview
    res.json({
      headers,
      sampleRows: rows,
      totalRows: lines.length - 1,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Apply AI-mapped column import
router.post('/contacts-csv/apply', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const mappings = JSON.parse(req.body.mappings || '{}');
    const text = req.file.buffer.toString('utf-8');
    const lines = text.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

    const Contact = (await import('../models/Contact.js')).default;
    let imported = 0;
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
      try {
        const vals = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
        const contact = { organization: req.organizationId, source: 'import' };

        headers.forEach((header, idx) => {
          const targetField = mappings[header];
          if (targetField && vals[idx]) {
            contact[targetField] = vals[idx];
          }
        });

        if (contact.firstName || contact.email) {
          await Contact.create(contact);
          imported++;
        }
      } catch (e) {
        errors.push(`Row ${i + 1}: ${e.message}`);
      }
    }

    res.json({ imported, errors: errors.slice(0, 5), total: lines.length - 1 });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ─── DEAL / CONTACT FILE ATTACHMENT ──────────────

router.post('/attachment', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const { entityType, entityId } = req.body;
    if (!entityType || !entityId) return res.status(400).json({ message: 'entityType and entityId required' });

    let fileUrl;
    if (configureCloudinary()) {
      const result = await uploadToCloudinary(req.file.buffer, `${req.organizationId}/attachments`);
      fileUrl = result.secure_url;
    } else {
      fileUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }

    const attachment = {
      name: req.file.originalname,
      url: fileUrl,
      type: req.file.mimetype,
      uploadedAt: new Date(),
    };

    if (entityType === 'deal') {
      const { Deal } = await import('../models/Deal.js');
      await Deal.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $push: { attachments: attachment } }
      );
    } else if (entityType === 'contact') {
      const Contact = (await import('../models/Contact.js')).default;
      await Contact.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $push: { attachments: attachment } }
      );
    }

    res.json(attachment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete attachment
router.delete('/attachment', protect, async (req, res) => {
  try {
    const { entityType, entityId, fileUrl } = req.body;

    if (entityType === 'deal') {
      const { Deal } = await import('../models/Deal.js');
      await Deal.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $pull: { attachments: { url: fileUrl } } }
      );
    } else if (entityType === 'contact') {
      const Contact = (await import('../models/Contact.js')).default;
      await Contact.findOneAndUpdate(
        { _id: entityId, organization: req.organizationId },
        { $pull: { attachments: { url: fileUrl } } }
      );
    }

    res.json({ message: 'Removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;