import { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { protect, requireSuperAdmin } from '../middleware/auth.js';
import LibraryImage from '../models/LibraryImage.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

const uploadToCloudinary = (buffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'safari-crm/library', resource_type: 'auto', quality: 'auto', fetch_format: 'auto' },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });

const parseTags = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return String(raw).split(',').map(t => t.trim()).filter(Boolean);
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build OR conditions that match each term as a case-insensitive substring
// against either a tag (array element) or the caption. Makes "elephant" find
// images tagged "elephants" or captioned "elephant herd".
const buildTermConditions = (terms) =>
  terms.flatMap(t => {
    const rx = new RegExp(escapeRegex(t), 'i');
    return [{ tags: rx }, { caption: rx }];
  });

// ─── PUBLIC (auth'd): search Pexels stock photos ─
// Server-side proxy keeps the API key off the client. Pexels License allows
// commercial use with attribution recommended — we surface photographer credit
// back to the UI via the standard {credit, creditUrl} shape.
router.get('/stock/search', protect, async (req, res) => {
  try {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) return res.status(503).json({ message: 'Stock photo search is not configured' });

    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ page: 1, perPage: 0, total: 0, items: [] });

    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(80, Math.max(1, Number(req.query.perPage) || 24));

    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}`;
    const response = await fetch(url, { headers: { Authorization: apiKey } });
    if (!response.ok) {
      // Don't proxy Pexels' upstream body — it can include rate-limit headers,
      // request-id strings, and other internal details that don't help our
      // client and may leak operational info. Log it server-side and return a
      // generic message.
      const detail = await response.text().catch(() => '');
      console.warn('[library/stock/search] pexels error', response.status, detail.slice(0, 200));
      return res.status(response.status).json({ message: `Stock photo search failed (${response.status})` });
    }
    const data = await response.json();

    const items = (data.photos || []).map(p => ({
      id: p.id,
      url: p.src?.large || p.src?.large2x || p.src?.original,
      thumbnail: p.src?.medium || p.src?.small || p.src?.tiny,
      credit: p.photographer,
      creditUrl: p.photographer_url,
      caption: p.alt || '',
      source: 'pexels',
      width: p.width,
      height: p.height,
    }));

    res.json({ page: data.page, perPage: data.per_page, total: data.total_results, items });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─── PUBLIC (auth'd): search active library ──────
// Any logged-in user can query. No org scoping — library is global.
router.get('/search', protect, async (req, res) => {
  try {
    const { q = '', type, limit = 40 } = req.query;
    const filter = { isActive: true };

    const terms = parseTags(q).map(t => t.toLowerCase());
    const termConds = buildTermConditions(terms);
    // Term matches (tag/caption substring) are specific; destinationType widens the net
    // so a "beach" day still surfaces generic beach shots when no image matches the term.
    if (terms.length && type) {
      filter.$or = [...termConds, { destinationType: type }];
    } else if (terms.length) {
      filter.$or = termConds;
    } else if (type) {
      filter.destinationType = type;
    }

    const items = await LibraryImage.find(filter)
      .select('url caption credit attribution sourceUrl tags destinationType')
      .sort({ usageCount: -1, createdAt: -1 })
      .limit(Math.min(Number(limit) || 40, 100))
      .lean();

    res.json(items);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─── Track usage (fire-and-forget from quote builder) ─
router.post('/:id/used', protect, async (req, res) => {
  try {
    await LibraryImage.findByIdAndUpdate(req.params.id, { $inc: { usageCount: 1 } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─── ADMIN: list all (incl. inactive) ────────────
router.get('/admin', protect, requireSuperAdmin, async (req, res) => {
  try {
    const { q, type, limit = 200 } = req.query;
    const filter = {};
    if (q) {
      const terms = parseTags(q).map(t => t.toLowerCase());
      const termConds = buildTermConditions(terms);
      if (terms.length && type) {
        filter.$and = [{ $or: termConds }, { destinationType: type }];
      } else if (terms.length) {
        filter.$or = termConds;
      } else if (type) {
        filter.destinationType = type;
      }
    } else if (type) {
      filter.destinationType = type;
    }
    const items = await LibraryImage.find(filter).sort({ createdAt: -1 }).limit(Number(limit));
    res.json(items);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─── ADMIN: upload new library image ─────────────
router.post('/admin', protect, requireSuperAdmin, upload.single('image'), async (req, res) => {
  try {
    const { caption = '', credit = '', attribution = '', sourceUrl = '', tags, destinationType = 'other', url: providedUrl } = req.body;
    let url = providedUrl;
    let publicId = '';

    if (req.file) {
      if (!configureCloudinary()) {
        return res.status(500).json({ message: 'Cloudinary not configured — set CLOUDINARY_* env vars to upload library images' });
      }
      const result = await uploadToCloudinary(req.file.buffer);
      url = result.secure_url;
      publicId = result.public_id;
    }

    if (!url) return res.status(400).json({ message: 'Provide either an image file or a url' });

    const item = await LibraryImage.create({
      url,
      publicId,
      caption,
      credit,
      attribution,
      sourceUrl,
      tags: parseTags(tags),
      destinationType,
      createdBy: req.user._id,
    });
    res.status(201).json(item);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─── ADMIN: update metadata ──────────────────────
router.put('/admin/:id', protect, requireSuperAdmin, async (req, res) => {
  try {
    const updates = {};
    const allowed = ['caption', 'credit', 'attribution', 'sourceUrl', 'destinationType', 'isActive'];
    for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
    if ('tags' in req.body) updates.tags = parseTags(req.body.tags).map(t => t.toLowerCase());

    const item = await LibraryImage.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!item) return res.status(404).json({ message: 'Not found' });
    res.json(item);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─── ADMIN: delete ───────────────────────────────
router.delete('/admin/:id', protect, requireSuperAdmin, async (req, res) => {
  try {
    const item = await LibraryImage.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Not found' });
    if (item.publicId && configureCloudinary()) {
      try { await cloudinary.uploader.destroy(item.publicId); } catch (_) {}
    }
    await item.deleteOne();
    res.json({ message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

export default router;
