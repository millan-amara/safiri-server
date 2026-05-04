import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import Quote from '../models/Quote.js';
import Organization from '../models/Organization.js';
import Hotel from '../models/Hotel.js';

const router = Router();

const PDF_SERVICE_URL = process.env.PDF_SERVICE_URL;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

async function hydrateBranding(quote) {
  const snap = quote.brandingSnapshot || {};
  if (snap.coverQuote && snap.aboutUs) return;
  const org = await Organization.findById(quote.organization).select('branding businessInfo').lean();
  if (!org) return;
  quote.brandingSnapshot = {
    ...snap,
    coverQuote: snap.coverQuote || org.branding?.coverQuote || '',
    coverQuoteAuthor: snap.coverQuoteAuthor || org.branding?.coverQuoteAuthor || '',
    aboutUs: snap.aboutUs || org.businessInfo?.aboutUs || '',
  };
}

async function hydrateHotelImages(quote) {
  const needsImages = (quote.days || []).filter(d => d.hotel?.name && !d.hotel.images?.length);
  if (!needsImages.length) return;

  const ids = [...new Set(needsImages.map(d => d.hotel.hotelId || d.hotel._id).filter(Boolean).map(String))];
  const names = [...new Set(needsImages.map(d => d.hotel.name).filter(Boolean))];

  // Both lookup branches MUST be scoped by organization, otherwise a hotelId
  // planted in days[].hotel from a tampered quote can pull cross-tenant data.
  const orConds = [];
  if (ids.length) orConds.push({ _id: { $in: ids } });
  if (names.length) orConds.push({ name: { $in: names } });
  if (!orConds.length) return;

  const hotels = await Hotel.find({ organization: quote.organization, $or: orConds }).select('name images').lean();
  const byId = new Map(hotels.map(h => [String(h._id), h.images || []]));
  const byName = new Map(hotels.map(h => [h.name, h.images || []]));

  for (const d of needsImages) {
    const id = d.hotel.hotelId || d.hotel._id;
    const imgs = (id && byId.get(String(id))) || byName.get(d.hotel.name) || [];
    if (imgs.length) d.hotel.images = imgs;
  }
}

async function fetchHydratedQuote(id, organizationId) {
  const quote = await Quote.findOne({ _id: id, organization: organizationId })
    .populate('contact')
    .populate('createdBy', 'name email phone jobTitle avatar signature signatureNote');
  if (!quote) return null;
  await hydrateBranding(quote);
  await hydrateHotelImages(quote);
  return quote;
}

async function callPdfService(path, quote) {
  if (!PDF_SERVICE_URL || !INTERNAL_TOKEN) {
    throw new Error('PDF service not configured (PDF_SERVICE_URL / INTERNAL_TOKEN missing)');
  }
  const payload = quote.toObject ? quote.toObject() : quote;
  const upstream = await fetch(`${PDF_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({ quote: payload }),
  });
  if (!upstream.ok) {
    const text = await upstream.text();
    throw new Error(`PDF service ${upstream.status}: ${text}`);
  }
  return Buffer.from(await upstream.arrayBuffer());
}

router.get('/:id/pdf', protect, async (req, res) => {
  try {
    const quote = await fetchHydratedQuote(req.params.id, req.organizationId);
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    const html = await callPdfService('/internal/render-html', quote);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('[pdf/preview] error:', error);
    res.status(500).json({ message: error.message });
  }
});

router.get('/:id/pdf/download', protect, async (req, res) => {
  try {
    const quote = await fetchHydratedQuote(req.params.id, req.organizationId);
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    const pdf = await callPdfService('/internal/render-pdf', quote);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="quote-${quote.quoteNumber || req.params.id}.pdf"`);
    res.send(pdf);
  } catch (error) {
    console.error('[pdf/download] error:', error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
