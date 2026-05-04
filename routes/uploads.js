import { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { protect } from '../middleware/auth.js';
import Hotel from '../models/Hotel.js';
import Activity from '../models/Activity.js';
import Transport from '../models/Transport.js';
import Organization from '../models/Organization.js';
import { enforceCsvRowCap } from '../middleware/partnerQuota.js';

const router = Router();

// Per-route multers. Image routes are restricted to common bitmap formats —
// SVG is excluded because Cloudinary delivers it as XML/JS-capable content
// that can run script in some viewers (and rendered inline in emails it's a
// stored-XSS vector). Attachments are looser but still capped.
const IMAGE_MIME_ALLOW = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CSV_MIME_ALLOW = new Set([
  'text/csv',
  'application/vnd.ms-excel',                                            // some browsers report this for .csv
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',   // .xlsx (we accept here too — partner import path)
  'text/plain',                                                          // some clients send this for .csv
]);
const ATTACHMENT_MIME_ALLOW = new Set([
  ...IMAGE_MIME_ALLOW,
  'application/pdf',
  ...CSV_MIME_ALLOW,
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function makeUpload(allow) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!allow.has(file.mimetype)) {
        return cb(new Error(`File type ${file.mimetype} is not allowed`));
      }
      cb(null, true);
    },
  });
}

const imageUpload = makeUpload(IMAGE_MIME_ALLOW);
const csvUpload = makeUpload(CSV_MIME_ALLOW);
const attachmentUpload = makeUpload(ATTACHMENT_MIME_ALLOW);

// Legacy alias kept so existing references don't break — points at the
// attachment-tier filter, the most permissive of the three.
const upload = attachmentUpload;

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

router.post('/image', protect, imageUpload.single('image'), async (req, res) => {
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

router.post('/logo', protect, imageUpload.single('logo'), async (req, res) => {
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

// ─── USER ASSET (avatar / signature) ─────────────
router.post('/user-asset', protect, imageUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    let url;
    if (configureCloudinary()) {
      const result = await uploadToCloudinary(req.file.buffer, `${req.organizationId}/users/${req.user._id}`);
      url = result.secure_url;
    } else {
      url = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }
    res.json({ url });
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

// RFC4180-ish CSV parser: handles quoted fields containing commas, quoted
// double-quotes (escaped as ""), and CRLF/LF/CR line endings. The previous
// version used split(',') which broke any field with a comma inside it
// (typical for "Last, First" name styles or freeform notes).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  // Strip a UTF-8 BOM if present so the first header doesn't include it.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; continue; }
      if (c === '"') { inQuotes = false; continue; }
      cell += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') { continue; } // handled by following \n or end-of-file
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  // Flush last cell/row if file didn't end with a newline.
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  // Drop fully-empty trailing rows.
  while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
  return rows;
}

const csvRowCounter = (file) => {
  const rows = parseCsv(file.buffer.toString('utf-8'));
  return Math.max(0, rows.length - 1); // minus header
};

router.post('/contacts-csv', protect, csvUpload.single('file'), enforceCsvRowCap(csvRowCounter), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const rows = parseCsv(req.file.buffer.toString('utf-8'));
    if (rows.length < 2) return res.status(400).json({ message: 'CSV must have headers and at least one row' });

    const headers = rows[0].map(h => h.trim());
    const sampleRows = rows.slice(1, 4).map(vals => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = (vals[i] ?? '').trim());
      return obj;
    });

    // Return headers + sample for AI mapping preview
    res.json({
      headers,
      sampleRows,
      totalRows: rows.length - 1,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Apply AI-mapped column import
router.post('/contacts-csv/apply', protect, csvUpload.single('file'), enforceCsvRowCap(csvRowCounter), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const mappings = JSON.parse(req.body.mappings || '{}');
    const rows = parseCsv(req.file.buffer.toString('utf-8'));
    if (rows.length < 2) return res.status(400).json({ message: 'CSV must have headers and at least one row' });
    const headers = rows[0].map(h => h.trim());

    const Contact = (await import('../models/Contact.js')).default;
    let imported = 0;
    const errors = [];

    for (let i = 1; i < rows.length; i++) {
      try {
        const vals = rows[i];
        const contact = { organization: req.organizationId, source: 'import' };

        headers.forEach((header, idx) => {
          const targetField = mappings[header];
          const v = (vals[idx] ?? '').trim();
          if (targetField && v) {
            contact[targetField] = v;
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

    res.json({ imported, errors: errors.slice(0, 5), total: rows.length - 1 });
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