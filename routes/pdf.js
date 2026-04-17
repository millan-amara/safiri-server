import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import Quote from '../models/Quote.js';
import Organization from '../models/Organization.js';
import Hotel from '../models/Hotel.js';

const router = Router();

// Tiny LRU-ish cache keyed by `${quoteId}:${updatedAt}` → PDF buffer
const pdfCache = new Map();
const PDF_CACHE_MAX = 20;
function cacheGet(key) {
  const v = pdfCache.get(key);
  if (v) {
    pdfCache.delete(key);
    pdfCache.set(key, v); // bump to most-recent
  }
  return v;
}
function cacheSet(key, val) {
  pdfCache.set(key, val);
  if (pdfCache.size > PDF_CACHE_MAX) {
    const firstKey = pdfCache.keys().next().value;
    pdfCache.delete(firstKey);
  }
}

// Shared browser instance — avoids ~3s Chromium startup on each request.
let browserPromise = null;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => {
    try { (await browserPromise)?.close(); } catch {}
  });
}
async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.connected) return b;
    browserPromise = null;
  }
  const { default: puppeteer } = await import('puppeteer');
  browserPromise = puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const browser = await browserPromise;
  browser.on('disconnected', () => { browserPromise = null; });
  return browser;
}

const mealLabels = { RO: 'Room Only', BB: 'Bed & Breakfast', HB: 'Half Board', FB: 'Full Board', AI: 'All Inclusive' };

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// SVG patterns as data URIs — kept subtle, tinted at render time with primary color
const patternDot = (color) => `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><circle cx='2' cy='2' r='1' fill='${color}' opacity='0.25'/></svg>`
)}")`;
const patternGrid = (color) => `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><path d='M0 16 L32 16 M16 0 L16 32' stroke='${color}' stroke-width='0.5' opacity='0.2'/></svg>`
)}")`;
const patternLines = (color) => `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='60' height='12'><path d='M0 6 L60 6' stroke='${color}' stroke-width='0.5' opacity='0.18'/></svg>`
)}")`;

// Kenya destination coordinates (mirror of link view)
const DEST_COORDS = {
  'nairobi': [-1.29, 36.82], 'maasai mara': [-1.5, 35.0], 'masai mara': [-1.5, 35.0],
  'amboseli': [-2.65, 37.25], 'tsavo east': [-2.9, 38.7], 'tsavo west': [-3.0, 38.2],
  'diani': [-4.32, 39.58], 'diani beach': [-4.32, 39.58], 'mombasa': [-4.04, 39.67],
  'naivasha': [-0.72, 36.36], 'lake naivasha': [-0.72, 36.36], 'nakuru': [-0.37, 36.08],
  'lake nakuru': [-0.37, 36.08], 'samburu': [0.6, 37.5], 'nanyuki': [0.0, 37.07],
  'mount kenya': [-0.15, 37.3], 'lamu': [-2.27, 40.9], 'malindi': [-3.22, 40.12],
  'watamu': [-3.35, 40.02],
};
function getCoords(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  for (const [k, v] of Object.entries(DEST_COORDS)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}

// Build a pure-SVG route map given start, end, and grouped day locations
function buildRouteSvg(quote, primaryColor, secondaryColor) {
  const points = [];
  const start = getCoords(quote.startPoint);
  if (start) points.push({ name: quote.startPoint, coords: start, type: 'start' });

  const locations = [];
  let lastLoc = null;
  for (const d of (quote.days || [])) {
    if (d.location && d.location !== lastLoc) {
      locations.push({ name: d.location, nights: 1 });
      lastLoc = d.location;
    } else if (d.location === lastLoc && locations.length) {
      locations[locations.length - 1].nights++;
    }
  }
  for (const loc of locations) {
    const c = getCoords(loc.name);
    if (c) points.push({ name: loc.name, coords: c, nights: loc.nights });
  }
  const end = getCoords(quote.endPoint);
  if (end && quote.endPoint !== locations[locations.length - 1]?.name) {
    points.push({ name: quote.endPoint, coords: end, type: 'end' });
  }

  if (points.length < 2) return '';

  // Project lat/lng to SVG coords (simple equirectangular)
  const W = 780, H = 360, PAD = 60;
  const lats = points.map(p => p.coords[0]);
  const lngs = points.map(p => p.coords[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const spanLat = Math.max(0.5, maxLat - minLat);
  const spanLng = Math.max(0.5, maxLng - minLng);
  const aspect = (W - 2 * PAD) / (H - 2 * PAD);
  const geoAspect = spanLng / spanLat;
  let scale;
  if (geoAspect > aspect) {
    scale = (W - 2 * PAD) / spanLng;
  } else {
    scale = (H - 2 * PAD) / spanLat;
  }
  const projW = spanLng * scale;
  const projH = spanLat * scale;
  const offX = (W - projW) / 2;
  const offY = (H - projH) / 2;
  const project = (lat, lng) => [
    offX + (lng - minLng) * scale,
    offY + (maxLat - lat) * scale, // flip y so north is up
  ];

  const projected = points.map(p => ({ ...p, xy: project(p.coords[0], p.coords[1]) }));
  const path = projected.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.xy[0].toFixed(1)},${p.xy[1].toFixed(1)}`).join(' ');

  return `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="display:block;">
    <defs>
      <linearGradient id="routeGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${primaryColor}"/>
        <stop offset="100%" stop-color="${secondaryColor}"/>
      </linearGradient>
    </defs>
    <!-- Subtle grid backdrop -->
    <rect width="${W}" height="${H}" fill="#fafaf9"/>
    <g opacity="0.12" stroke="${primaryColor}" stroke-width="0.5">
      ${Array.from({ length: 8 }, (_, i) => `<line x1="0" y1="${(i + 1) * H / 9}" x2="${W}" y2="${(i + 1) * H / 9}"/>`).join('')}
      ${Array.from({ length: 16 }, (_, i) => `<line y1="0" x1="${(i + 1) * W / 17}" y2="${H}" x2="${(i + 1) * W / 17}"/>`).join('')}
    </g>

    <!-- Route line (dashed) -->
    <path d="${path}" fill="none" stroke="url(#routeGrad)" stroke-width="2.5" stroke-dasharray="6 5" stroke-linecap="round"/>

    <!-- Points -->
    ${projected.map((p, i) => {
      const isStart = p.type === 'start';
      const isEnd = p.type === 'end';
      const r = isStart || isEnd ? 9 : 7;
      const labelY = p.xy[1] < H / 2 ? p.xy[1] + r + 18 : p.xy[1] - r - 10;
      return `
        <g>
          <circle cx="${p.xy[0]}" cy="${p.xy[1]}" r="${r + 6}" fill="${primaryColor}" opacity="0.12"/>
          <circle cx="${p.xy[0]}" cy="${p.xy[1]}" r="${r}" fill="${primaryColor}" stroke="#fff" stroke-width="2.5"/>
          ${!isStart && !isEnd ? `<text x="${p.xy[0]}" y="${p.xy[1] + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" font-family="sans-serif">${i}</text>` : ''}
          <text x="${p.xy[0]}" y="${labelY}" text-anchor="middle" font-size="11" font-weight="700" fill="#1c1917" font-family="sans-serif">${escapeHtml(p.name)}</text>
          ${p.nights ? `<text x="${p.xy[0]}" y="${labelY + 13}" text-anchor="middle" font-size="9" fill="#78716c" font-family="sans-serif">${p.nights} night${p.nights !== 1 ? 's' : ''}</text>` : (isStart ? `<text x="${p.xy[0]}" y="${labelY + 13}" text-anchor="middle" font-size="9" fill="#78716c" font-family="sans-serif">Start</text>` : (isEnd ? `<text x="${p.xy[0]}" y="${labelY + 13}" text-anchor="middle" font-size="9" fill="#78716c" font-family="sans-serif">End</text>` : ''))}
        </g>
      `;
    }).join('')}
  </svg>`;
}

// Style presets — pick typography + accent + pattern + photo treatment
const STYLE_PRESETS = {
  editorial: {
    fontImport: `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Playfair+Display:wght@500;600;700;800&family=Caveat:wght@500;700&display=swap');`,
    bodyFont: `'DM Sans', system-ui, sans-serif`,
    headingFont: `'Playfair Display', serif`,
    headingWeight: 700,
    coverH1Size: '52px',
    sectionTitleSize: '24px',
    eyebrowLetterSpacing: '2.5px',
    accentShape: 'bar',
    pattern: patternDot,
    photoRadius: '10px',
    photoFrame: '',
  },
  modern: {
    fontImport: `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Caveat:wght@500;700&display=swap');`,
    bodyFont: `'Inter', system-ui, sans-serif`,
    headingFont: `'Inter', system-ui, sans-serif`,
    headingWeight: 800,
    coverH1Size: '56px',
    sectionTitleSize: '26px',
    eyebrowLetterSpacing: '3px',
    accentShape: 'dot',
    pattern: patternGrid,
    photoRadius: '0px',
    photoFrame: '',
  },
  minimal: {
    fontImport: `@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Nunito+Sans:wght@300;400;600;700&family=Caveat:wght@500;700&display=swap');`,
    bodyFont: `'Nunito Sans', system-ui, sans-serif`,
    headingFont: `'Cormorant Garamond', serif`,
    headingWeight: 500,
    coverH1Size: '58px',
    sectionTitleSize: '28px',
    eyebrowLetterSpacing: '4px',
    accentShape: 'line',
    pattern: patternLines,
    photoRadius: '2px',
    photoFrame: 'padding: 6px; background: #fff; border: 1px solid #e7e5e4;',
  },
};

function buildHtml(quote) {
  const brand = quote.brandingSnapshot || {};
  const primaryColor = brand.primaryColor || '#B45309';
  const secondaryColor = brand.secondaryColor || primaryColor;
  const style = STYLE_PRESETS[quote.pdfStyle] || STYLE_PRESETS.editorial;
  const coverLayout = quote.coverLayout || 'full_bleed';
  const accentCss =
    style.accentShape === 'dot' ? `width:10px; height:10px; border-radius:50%;` :
    style.accentShape === 'line' ? `width:80px; height:1px;` :
    `width:44px; height:3px; border-radius:2px;`;
  const patternUrl = style.pattern(primaryColor);

  // Pick a locale from the contact's country (falls back to en-US)
  const COUNTRY_LOCALE = {
    'Kenya': 'en-KE', 'Tanzania': 'en-TZ', 'Uganda': 'en-UG',
    'United Kingdom': 'en-GB', 'UK': 'en-GB', 'Ireland': 'en-IE',
    'United States': 'en-US', 'USA': 'en-US', 'Canada': 'en-CA',
    'Australia': 'en-AU', 'New Zealand': 'en-NZ',
    'Germany': 'de-DE', 'France': 'fr-FR', 'Spain': 'es-ES', 'Italy': 'it-IT',
    'Netherlands': 'nl-NL', 'Belgium': 'nl-BE', 'Portugal': 'pt-PT',
    'Brazil': 'pt-BR', 'Mexico': 'es-MX',
    'Japan': 'ja-JP', 'China': 'zh-CN', 'India': 'en-IN', 'UAE': 'en-AE',
    'South Africa': 'en-ZA',
  };
  const locale = COUNTRY_LOCALE[quote.contact?.country] || 'en-US';

  const fmtCurrency = (amt, cur = 'USD') =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 0 }).format(amt || 0);

  const fmtDate = (d) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };
  const fmtDateShort = (d) => {
    if (!d) return '';
    return new Date(d).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const rawDays = quote.days || [];
  const totalDays = rawDays.length;
  const totalNights = Math.max(0, totalDays - 1);
  const totalPax = (quote.travelers?.adults || 0) + (quote.travelers?.children || 0);

  // Build day display list with dates
  let curDate = quote.startDate ? new Date(quote.startDate) : null;
  const days = rawDays.map((d, i) => {
    const date = curDate ? new Date(curDate) : null;
    if (curDate) curDate.setDate(curDate.getDate() + 1);
    return {
      num: d.dayNumber || i + 1,
      date,
      title: d.title || '',
      destination: d.location || '',
      hotel: d.hotel || null,
      narrative: d.narrative || '',
      activities: d.activities || [],
      mealPlan: d.hotel?.mealPlan || '',
      meals: d.meals,
      transport: d.transport || null,
      heroImage: d.images?.[0] || d.hotel?.images?.[0] || null,
      images: d.images || [],
    };
  });

  // Group consecutive days by location for "at a glance"
  const locations = [];
  let dayCounter = 1;
  let lastLoc = null;
  for (const d of rawDays) {
    if (d.location && d.location !== lastLoc) {
      locations.push({ name: d.location, startDay: dayCounter, nights: 1, hotel: d.hotel, transport: d.transport });
      lastLoc = d.location;
    } else if (d.location === lastLoc && locations.length) {
      locations[locations.length - 1].nights++;
    }
    dayCounter++;
  }

  // Unique hotels
  const uniqueHotels = [];
  const seen = new Set();
  for (const d of rawDays) {
    if (d.hotel?.name && !seen.has(d.hotel.name)) {
      seen.add(d.hotel.name);
      uniqueHotels.push(d.hotel);
    }
  }

  const blockOn = (id) => {
    const b = quote.blocks?.find(x => x.id === id);
    return b ? b.enabled : true;
  };

  const coverImg =
    quote.coverImage?.url ||
    quote.days?.find(d => d.images?.[0]?.url)?.images?.[0]?.url ||
    quote.days?.find(d => d.hotel?.images?.[0]?.url)?.hotel?.images?.[0]?.url ||
    '';

  const contactName = [quote.contact?.firstName, quote.contact?.lastName].filter(Boolean).join(' ');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(quote.title || 'Travel Proposal')}</title>
<style>
  ${style.fontImport}

  @page { size: A4; margin: 0; }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 210mm; }
  body {
    font-family: ${style.bodyFont};
    color: #1c1917;
    font-size: 10.5px;
    line-height: 1.55;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4 { font-family: ${style.headingFont}; color: #1c1917; font-weight: ${style.headingWeight}; }

  .page {
    width: 210mm;
    min-height: 297mm;
    padding: 18mm 16mm;
    page-break-after: always;
    position: relative;
    background: #fff;
  }
  .page::before {
    content: '';
    position: absolute; top: 0; right: 0;
    width: 90mm; height: 60mm;
    background-image: ${patternUrl};
    pointer-events: none;
    opacity: 0.6;
  }
  .page::after {
    content: '';
    position: absolute; left: 16mm; right: 16mm; top: 14mm;
    height: 1px;
    background: linear-gradient(90deg, ${primaryColor}30 0%, transparent 100%);
  }
  .page:last-child { page-break-after: auto; }
  .page.no-pad { padding: 0; }

  .accent-bar { ${accentCss} background: linear-gradient(90deg, ${primaryColor} 0%, ${secondaryColor} 100%); margin-bottom: 14px; display: block; }
  .eyebrow { font-size: 9px; letter-spacing: ${style.eyebrowLetterSpacing}; text-transform: uppercase; font-weight: 600; color: ${primaryColor}; }
  .muted { color: #78716c; }
  .section-title { font-size: ${style.sectionTitleSize}; line-height: 1.15; margin-bottom: 4px; }
  .section-sub { font-size: 11px; color: #78716c; margin-bottom: 22px; }

  /* ─── COVER (shared) ─── */
  .cover {
    width: 210mm; height: 297mm;
    position: relative;
    overflow: hidden;
    page-break-after: always;
  }
  .cover.full_bleed { color: #fff; }
  .cover.split { display: grid; grid-template-columns: 45% 55%; color: #1c1917; }
  .cover.band { display: flex; flex-direction: column; color: #1c1917; }

  /* SPLIT cover */
  .split-img-wrap { position: relative; overflow: hidden; background: linear-gradient(135deg, ${primaryColor}, ${secondaryColor}); }
  .split-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .split-text { padding: 22mm 18mm; display: flex; flex-direction: column; justify-content: space-between; background: #fff; }
  .split-text h1 { font-size: ${style.coverH1Size}; line-height: 1.05; color: #1c1917; font-weight: ${style.headingWeight}; letter-spacing: -0.5px; margin-bottom: 16px; }
  .split-narr { font-size: 12px; line-height: 1.65; color: #57534e; margin-bottom: 26px; }
  .split-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .split-meta-cell { padding: 10px 12px; border-left: 2px solid ${primaryColor}; background: #fafaf9; }
  .split-meta-label { font-size: 8px; letter-spacing: 1.5px; text-transform: uppercase; color: #a8a29e; font-weight: 600; margin-bottom: 3px; }
  .split-meta-value { font-size: 12px; font-weight: 600; color: #1c1917; }

  /* BAND cover */
  .band-img-wrap { position: relative; height: 40%; overflow: hidden; background: linear-gradient(135deg, ${primaryColor}, ${secondaryColor}); }
  .band-img { width: 100%; height: 100%; object-fit: cover; }
  .band-body { flex: 1; padding: 18mm 18mm; display: flex; flex-direction: column; justify-content: space-between; background: #fff; }
  .band-body h1 { font-size: ${style.coverH1Size}; line-height: 1.05; color: #1c1917; font-weight: ${style.headingWeight}; letter-spacing: -0.5px; margin: 10px 0 14px; }
  .band-narr { font-size: 12px; line-height: 1.65; color: #57534e; margin-bottom: 22px; max-width: 155mm; }
  .band-accent { height: 4px; width: 100%; background: linear-gradient(90deg, ${primaryColor} 0%, ${secondaryColor} 100%); }
  .cover-bg {
    position: absolute; inset: 0;
    background: linear-gradient(135deg, ${primaryColor} 0%, #1c1917 100%);
  }
  .cover-bg-img {
    position: absolute; inset: 0;
    width: 100%; height: 100%; object-fit: cover;
    display: block;
  }
  .cover-overlay {
    position: absolute; inset: 0;
    background: linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.15) 40%, rgba(0,0,0,0.85) 100%);
  }
  .cover-inner { position: absolute; inset: 0; z-index: 2; padding: 18mm 16mm; }
  .cover-top { position: absolute; top: 18mm; left: 16mm; right: 16mm; display: flex; justify-content: space-between; align-items: flex-start; }
  .cover-logo { height: 36px; object-fit: contain; }
  .cover-org { font-size: 11px; letter-spacing: 3px; text-transform: uppercase; font-weight: 600; opacity: 0.95; color: #fff; }
  .cover-badge {
    display: inline-block;
    font-size: 9px; letter-spacing: 2.5px; text-transform: uppercase; font-weight: 600;
    padding: 5px 10px; border: 1px solid rgba(255,255,255,0.6); border-radius: 3px;
    background: rgba(0,0,0,0.25); color: #fff;
  }
  .cover-main { position: absolute; left: 16mm; right: 16mm; bottom: 32mm; }
  .cover-main h1 {
    font-size: ${style.coverH1Size}; line-height: 1.05; color: #fff; font-weight: ${style.headingWeight}; letter-spacing: -0.5px;
    margin-bottom: 14px; max-width: 165mm;
  }
  .cover-for { font-size: 11px; opacity: 0.9; margin-bottom: 14px; letter-spacing: 0.5px; color: #fff; }
  .cover-narr { font-size: 12px; line-height: 1.6; max-width: 135mm; opacity: 0.95; margin-bottom: 22px; color: #fff; }
  .cover-meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; max-width: 165mm; }
  .cover-meta-cell {
    padding: 10px 12px; border-left: 2px solid ${primaryColor};
    background: rgba(0,0,0,0.35); color: #fff;
  }
  .cover-meta-label { font-size: 8px; letter-spacing: 1.5px; text-transform: uppercase; opacity: 0.8; margin-bottom: 3px; }
  .cover-meta-value { font-size: 12px; font-weight: 600; }
  .cover-bottom { position: absolute; left: 16mm; right: 16mm; bottom: 12mm; display: flex; justify-content: space-between; font-size: 9px; letter-spacing: 0.5px; opacity: 0.85; color: #fff; }

  /* ─── AT A GLANCE ─── */
  .glance-row { display: flex; gap: 14px; padding: 12px 0; border-bottom: 1px solid #f5f5f4; }
  .glance-row:last-child { border-bottom: none; }
  .glance-num {
    width: 34px; height: 34px; border-radius: 50%;
    background: ${primaryColor}; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; flex-shrink: 0;
  }
  .glance-body { flex: 1; }
  .glance-dest { font-size: 13px; font-weight: 700; color: #1c1917; }
  .glance-meta { font-size: 10px; color: #78716c; margin-top: 2px; }
  .glance-transport { font-size: 10px; color: #a8a29e; margin-top: 4px; }

  .highlights-box {
    margin-top: 24px; padding: 14px 16px;
    background: ${primaryColor}08; border: 1px solid ${primaryColor}22; border-radius: 10px;
  }
  .highlights-label { font-size: 9px; letter-spacing: 1.8px; text-transform: uppercase; font-weight: 600; color: ${primaryColor}; margin-bottom: 8px; }
  .chip {
    display: inline-block; background: #fff; border: 1px solid ${primaryColor}33;
    padding: 4px 10px; border-radius: 14px; font-size: 10px; color: #44403c;
    margin: 0 4px 4px 0;
  }

  /* ─── DAY PAGE ─── */
  .day-hero-wrap { position: relative; margin-bottom: 14px; border-radius: ${style.photoRadius}; overflow: hidden; ${style.photoFrame} }
  .day-hero {
    width: 100%; height: 72mm; object-fit: cover;
    display: block;
  }
  .day-hero-badge {
    position: absolute; left: 14px; bottom: 14px;
    background: #fff; padding: 10px 14px; border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.25);
    display: flex; align-items: center; gap: 10px;
  }
  .day-hero-num {
    width: 42px; height: 42px; border-radius: 8px;
    background: ${primaryColor}; color: #fff;
    display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .day-hero-num-lbl { font-size: 7px; letter-spacing: 1px; text-transform: uppercase; opacity: 0.85; }
  .day-hero-num-val { font-size: 17px; font-weight: 700; line-height: 1; margin-top: 1px; }
  .day-hero-meta-lbl { font-size: 9px; color: #a8a29e; letter-spacing: 1.2px; text-transform: uppercase; font-weight: 600; }
  .day-hero-meta-val { font-size: 13px; font-weight: 700; color: #1c1917; }
  .day-hero-date { font-size: 10px; color: #78716c; margin-top: 1px; }

  .day-body { padding-top: 2px; }
  .day-gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-bottom: 14px; }
  .day-gallery img { width: 100%; height: 28mm; object-fit: cover; display: block; border-radius: ${style.photoRadius}; }
  .day-gallery.small img { height: 22mm; }
  .day-title { font-size: 22px; line-height: 1.2; margin-bottom: 4px; }
  .day-transport { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; background: #fafaf9; padding: 4px 10px; border-radius: 4px; color: #57534e; margin-bottom: 12px; }
  .day-narr { font-size: 11px; line-height: 1.7; color: #44403c; margin-bottom: 16px; }

  .day-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 18px; }
  .activities h4, .hotel-block h4, .meals-block h4 {
    font-family: 'DM Sans', sans-serif;
    font-size: 9px; letter-spacing: 1.8px; text-transform: uppercase; font-weight: 700;
    color: #a8a29e; margin-bottom: 8px;
  }
  .activity {
    display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f5f5f4;
  }
  .activity:last-child { border-bottom: none; }
  .activity-time {
    font-size: 8px; letter-spacing: 1px; text-transform: uppercase; font-weight: 600;
    color: ${primaryColor}; width: 56px; flex-shrink: 0; padding-top: 1px;
  }
  .activity-body { font-size: 10.5px; color: #1c1917; line-height: 1.55; flex: 1; }
  .activity-name { font-weight: 600; }
  .activity-desc { color: #57534e; font-size: 10px; margin-top: 1px; }

  .hotel-card {
    background: #fafaf9; border: 1px solid #e7e5e4; border-radius: ${style.photoRadius}; overflow: hidden;
  }
  .hotel-img { width: 100%; height: 85px; object-fit: cover; display: block; }
  .hotel-body { padding: 12px; }
  .hotel-eyebrow { font-size: 8px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; color: ${primaryColor}; margin-bottom: 4px; }
  .hotel-name { font-size: 12px; font-weight: 700; color: #1c1917; line-height: 1.3; }
  .hotel-detail { font-size: 10px; color: #78716c; margin-top: 2px; }

  .meals-block { margin-top: 14px; background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; padding: 12px; }
  .meals-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .meal-pill { font-size: 10px; padding: 3px 9px; border-radius: 12px; background: ${primaryColor}10; color: ${primaryColor}; font-weight: 600; }
  .meal-pill.off { background: #f5f5f4; color: #a8a29e; }

  /* ─── ACCOMMODATIONS ─── */
  .acc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .acc-card { border: 1px solid #e7e5e4; border-radius: ${style.photoRadius}; overflow: hidden; background: #fff; ${style.photoFrame} }
  .acc-img { width: 100%; height: 90px; object-fit: cover; display: block; background: #f5f5f4; }
  .acc-body { padding: 10px 12px; }
  .acc-name { font-size: 11px; font-weight: 700; color: #1c1917; }
  .acc-meta { font-size: 9px; color: #78716c; margin-top: 2px; }

  /* ─── PRICING ─── */
  .price-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 20px; align-items: start; }
  .price-table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  .price-table th { text-align: left; font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: #a8a29e; font-weight: 700; padding: 8px 0; border-bottom: 1px solid #e7e5e4; }
  .price-table td { padding: 9px 0; border-bottom: 1px solid #f5f5f4; font-size: 10.5px; color: #44403c; }
  .total-row {
    margin-top: 14px; padding-top: 14px; border-top: 2px solid #1c1917;
    display: flex; justify-content: space-between; align-items: baseline;
  }
  .total-lbl { font-size: 13px; font-weight: 700; }
  .total-val { font-size: 28px; font-weight: 700; color: ${primaryColor}; letter-spacing: -0.5px; font-family: 'Playfair Display', serif; }
  .per-person { text-align: right; font-size: 9px; color: #a8a29e; margin-top: 2px; }

  .side-card {
    background: ${primaryColor}06; border: 1px solid ${primaryColor}20; border-radius: 10px; padding: 14px;
  }
  .side-row { margin-bottom: 10px; }
  .side-row:last-child { margin-bottom: 0; }
  .side-label { font-size: 8px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; color: #a8a29e; }
  .side-value { font-size: 11px; font-weight: 600; color: #1c1917; margin-top: 2px; }

  .inc-exc { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 22px; }
  .inc-col h4 { font-family: 'DM Sans', sans-serif; font-size: 10px; font-weight: 700; color: #1c1917; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.8px; }
  .inc-item { display: flex; gap: 6px; padding: 3px 0; font-size: 10px; color: #44403c; line-height: 1.5; }
  .inc-tick { color: #22c55e; flex-shrink: 0; font-weight: 700; }
  .exc-tick { color: #ef4444; flex-shrink: 0; font-weight: 700; }

  .terms-box { margin-top: 22px; padding: 14px; background: #fafaf9; border-radius: 10px; border-left: 3px solid ${primaryColor}; }
  .terms-box-label { font-size: 9px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; color: ${primaryColor}; margin-bottom: 6px; }
  .terms-body { font-size: 10px; color: #44403c; line-height: 1.6; white-space: pre-wrap; }

  /* ─── FOOTER ─── */
  .footer {
    position: absolute; left: 16mm; right: 16mm; bottom: 10mm;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 8px; letter-spacing: 0.5px; color: #a8a29e;
    padding-top: 8px; border-top: 1px solid #f5f5f4;
  }

  .draft-stamp {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%) rotate(-28deg);
    font-family: ${style.headingFont};
    font-size: 140px; font-weight: 800; letter-spacing: 10px;
    color: rgba(220, 38, 38, 0.1);
    border: 7px solid rgba(220, 38, 38, 0.14);
    padding: 10px 40px; border-radius: 14px;
    pointer-events: none; z-index: 5;
    white-space: nowrap; line-height: 1;
  }

  /* ─── CLOSING ─── */
  .closing {
    display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center;
    min-height: 297mm; padding: 32mm 20mm;
  }
  .closing-logo { height: 48px; object-fit: contain; margin-bottom: 18px; }
  .closing-name { font-size: 28px; margin-bottom: 14px; }
  .closing-contact { font-size: 11px; color: #57534e; line-height: 1.9; }
  .sig-block {
    margin-top: 36px; padding: 20px 28px; max-width: 140mm;
    background: #fafaf9; border: 1px solid #e7e5e4; border-radius: ${style.photoRadius};
    display: flex; flex-direction: column; align-items: center;
  }
  .sig-note { font-size: 12px; color: #44403c; line-height: 1.65; font-style: italic; margin-bottom: 18px; }
  .sig-image { height: 52px; object-fit: contain; margin-bottom: 10px; }
  .sig-handwritten { font-family: 'Caveat', 'Brush Script MT', cursive; font-size: 26px; color: ${primaryColor}; margin-bottom: 8px; line-height: 1; }
  .sig-author { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
  .sig-avatar { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
  .sig-meta { text-align: left; }
  .sig-name { font-size: 11px; font-weight: 700; color: #1c1917; }
  .sig-title { font-size: 9.5px; color: #78716c; }
  .closing-quote { font-size: 15px; color: #a8a29e; margin-top: 32px; font-family: ${style.headingFont}; font-style: italic; line-height: 1.5; }
</style>
</head>
<body>

<!-- ═══ COVER ═══ -->
${coverLayout === 'split' ? `
<div class="cover split">
  <div class="split-img-wrap">
    ${coverImg ? `<img class="split-img" src="${escapeHtml(coverImg)}">` : ''}
  </div>
  <div class="split-text">
    <div>
      ${brand.logo ? `<img src="${escapeHtml(brand.logo)}" style="height:34px; object-fit:contain; margin-bottom:28px;">` : `<div style="font-size:11px; letter-spacing:2.5px; text-transform:uppercase; font-weight:600; color:${primaryColor}; margin-bottom:28px;">${escapeHtml(brand.companyName || '')}</div>`}
      <div class="eyebrow" style="margin-bottom:12px;">Travel Proposal</div>
      ${contactName ? `<div style="font-size:11px; color:#78716c; margin-bottom:14px;">Prepared for ${escapeHtml(contactName)}</div>` : ''}
      <h1>${escapeHtml(quote.title || 'Travel Proposal')}</h1>
      ${quote.coverNarrative ? `<p class="split-narr">${escapeHtml(quote.coverNarrative)}</p>` : ''}
      <div class="split-meta">
        <div class="split-meta-cell"><div class="split-meta-label">Duration</div><div class="split-meta-value">${totalDays}D / ${totalNights}N</div></div>
        <div class="split-meta-cell"><div class="split-meta-label">Travelers</div><div class="split-meta-value">${totalPax} ${totalPax === 1 ? 'Guest' : 'Guests'}</div></div>
        <div class="split-meta-cell"><div class="split-meta-label">Departs</div><div class="split-meta-value">${quote.startDate ? escapeHtml(fmtDateShort(quote.startDate)) : 'TBD'}</div></div>
        <div class="split-meta-cell"><div class="split-meta-label">Tour Type</div><div class="split-meta-value">${escapeHtml((quote.tourType || 'private').charAt(0).toUpperCase() + (quote.tourType || 'private').slice(1))}</div></div>
      </div>
    </div>
    <div style="font-size:9px; color:#a8a29e; letter-spacing:0.5px; display:flex; justify-content:space-between; padding-top:12px; border-top:1px solid #f5f5f4;">
      <span>Quote #${escapeHtml(quote.quoteNumber || '—')}</span>
      <span>${escapeHtml(brand.companyName || '')}</span>
    </div>
  </div>
</div>
` : coverLayout === 'band' ? `
<div class="cover band">
  <div class="band-img-wrap">
    ${coverImg ? `<img class="band-img" src="${escapeHtml(coverImg)}">` : ''}
  </div>
  <div class="band-accent"></div>
  <div class="band-body">
    <div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:22px;">
        ${brand.logo ? `<img src="${escapeHtml(brand.logo)}" style="height:34px; object-fit:contain;">` : `<div style="font-size:11px; letter-spacing:2.5px; text-transform:uppercase; font-weight:600; color:${primaryColor};">${escapeHtml(brand.companyName || '')}</div>`}
        <div class="eyebrow">Travel Proposal</div>
      </div>
      ${contactName ? `<div style="font-size:11px; color:#78716c;">Prepared for ${escapeHtml(contactName)}</div>` : ''}
      <h1>${escapeHtml(quote.title || 'Travel Proposal')}</h1>
      ${quote.coverNarrative ? `<p class="band-narr">${escapeHtml(quote.coverNarrative)}</p>` : ''}
      <div class="split-meta" style="grid-template-columns:repeat(4,1fr); max-width:155mm;">
        <div class="split-meta-cell"><div class="split-meta-label">Duration</div><div class="split-meta-value">${totalDays}D / ${totalNights}N</div></div>
        <div class="split-meta-cell"><div class="split-meta-label">Travelers</div><div class="split-meta-value">${totalPax} ${totalPax === 1 ? 'Guest' : 'Guests'}</div></div>
        <div class="split-meta-cell"><div class="split-meta-label">Departs</div><div class="split-meta-value">${quote.startDate ? escapeHtml(fmtDateShort(quote.startDate)) : 'TBD'}</div></div>
        <div class="split-meta-cell"><div class="split-meta-label">Tour Type</div><div class="split-meta-value">${escapeHtml((quote.tourType || 'private').charAt(0).toUpperCase() + (quote.tourType || 'private').slice(1))}</div></div>
      </div>
    </div>
    <div style="font-size:9px; color:#a8a29e; letter-spacing:0.5px; display:flex; justify-content:space-between; padding-top:12px; border-top:1px solid #f5f5f4;">
      <span>Quote #${escapeHtml(quote.quoteNumber || '—')}</span>
      <span>${escapeHtml(brand.companyName || '')}${brand.companyPhone ? ' · ' + escapeHtml(brand.companyPhone) : ''}</span>
    </div>
  </div>
</div>
` : `
<div class="cover full_bleed">
  <div class="cover-bg"></div>
  ${coverImg ? `<img class="cover-bg-img" src="${escapeHtml(coverImg)}">` : ''}
  <div class="cover-overlay"></div>
  <div class="cover-inner">
    <div class="cover-top">
      ${brand.logo ? `<img class="cover-logo" src="${escapeHtml(brand.logo)}">` : `<div class="cover-org">${escapeHtml(brand.companyName || '')}</div>`}
      <div class="cover-badge">Travel Proposal</div>
    </div>
    <div class="cover-main">
      ${contactName ? `<div class="cover-for">Prepared for ${escapeHtml(contactName)}</div>` : ''}
      <h1>${escapeHtml(quote.title || 'Travel Proposal')}</h1>
      ${quote.coverNarrative ? `<p class="cover-narr">${escapeHtml(quote.coverNarrative)}</p>` : ''}
      <div class="cover-meta">
        <div class="cover-meta-cell"><div class="cover-meta-label">Duration</div><div class="cover-meta-value">${totalDays}D / ${totalNights}N</div></div>
        <div class="cover-meta-cell"><div class="cover-meta-label">Travelers</div><div class="cover-meta-value">${totalPax} ${totalPax === 1 ? 'Guest' : 'Guests'}</div></div>
        <div class="cover-meta-cell"><div class="cover-meta-label">Departs</div><div class="cover-meta-value">${quote.startDate ? escapeHtml(fmtDateShort(quote.startDate)) : 'TBD'}</div></div>
        <div class="cover-meta-cell"><div class="cover-meta-label">Tour Type</div><div class="cover-meta-value">${escapeHtml((quote.tourType || 'private').charAt(0).toUpperCase() + (quote.tourType || 'private').slice(1))}</div></div>
      </div>
    </div>
    <div class="cover-bottom">
      <span>Quote #${escapeHtml(quote.quoteNumber || '—')}</span>
      <span>${escapeHtml(brand.companyName || '')}${brand.companyPhone ? ' · ' + escapeHtml(brand.companyPhone) : ''}</span>
    </div>
  </div>
</div>
`}

<!-- ═══ AT A GLANCE ═══ -->
${blockOn('highlights') ? `
<div class="page">
  <div class="accent-bar"></div>
  <div class="eyebrow">Overview</div>
  <h2 class="section-title">Your Itinerary at a Glance</h2>
  <p class="section-sub">
    ${escapeHtml(quote.startPoint || 'Nairobi')} → ${escapeHtml(quote.endPoint || 'Nairobi')}
    ${quote.startDate ? ' · ' + escapeHtml(fmtDate(quote.startDate)) : ''}
  </p>

  ${locations.map(loc => {
    const endDay = loc.startDay + loc.nights - 1;
    return `
    <div class="glance-row">
      <div class="glance-num">${loc.startDay}</div>
      <div class="glance-body">
        <div class="glance-dest">${escapeHtml(loc.name)}</div>
        <div class="glance-meta">
          Day ${loc.startDay}${endDay !== loc.startDay ? '–' + endDay : ''} · ${loc.nights} night${loc.nights !== 1 ? 's' : ''}
          ${loc.hotel?.name ? ' · ' + escapeHtml(loc.hotel.name) : ''}
          ${loc.hotel?.mealPlan ? ' · ' + escapeHtml(mealLabels[loc.hotel.mealPlan] || loc.hotel.mealPlan) : ''}
        </div>
        ${loc.transport?.name ? `<div class="glance-transport">→ ${escapeHtml(loc.transport.name)}${loc.transport.estimatedTime ? ' (' + escapeHtml(loc.transport.estimatedTime) + ')' : ''}</div>` : ''}
      </div>
    </div>`;
  }).join('')}

  ${quote.highlights?.length ? `
    <div class="highlights-box">
      <div class="highlights-label">Trip Highlights</div>
      <div>
        ${quote.highlights.map(h => `<span class="chip">★ ${escapeHtml(h)}</span>`).join('')}
      </div>
    </div>
  ` : ''}

  <div class="footer">
    <span>Quote #${escapeHtml(quote.quoteNumber || '—')}</span>
    <span>${escapeHtml(brand.companyName || '')}</span>
  </div>
</div>` : ''}

<!-- ═══ ROUTE MAP ═══ -->
${blockOn('map') && (() => {
  const svg = buildRouteSvg(quote, primaryColor, secondaryColor);
  return svg ? `
    <div class="page">
      <div class="accent-bar"></div>
      <div class="eyebrow">Your Journey</div>
      <h2 class="section-title">The Route</h2>
      <p class="section-sub">From ${escapeHtml(quote.startPoint || '')} to ${escapeHtml(quote.endPoint || '')} · ${totalDays} days</p>
      <div style="margin-top:18px; padding:12px; background:#fafaf9; border:1px solid #e7e5e4; border-radius:${style.photoRadius};">
        ${svg}
      </div>
      <p style="font-size:9px; color:#a8a29e; margin-top:10px; text-align:center;">Distances and positions are approximate</p>
      <div class="footer">
        <span>Quote #${escapeHtml(quote.quoteNumber || '—')}</span>
        <span>${escapeHtml(brand.companyName || '')}</span>
      </div>
    </div>` : '';
})()}

<!-- ═══ DAY BY DAY ═══ -->
${blockOn('day_by_day') ? days.map(day => `
<div class="page">
  ${day.heroImage?.url ? `
    <div class="day-hero-wrap">
      <img class="day-hero" src="${escapeHtml(day.heroImage.url)}">
      <div class="day-hero-badge">
        <div class="day-hero-num">
          <span class="day-hero-num-lbl">Day</span>
          <span class="day-hero-num-val">${day.num}</span>
        </div>
        <div>
          <div class="day-hero-meta-lbl">${escapeHtml(day.destination || '')}</div>
          <div class="day-hero-meta-val">${escapeHtml(day.title || day.destination || `Day ${day.num}`)}</div>
          ${day.date ? `<div class="day-hero-date">${escapeHtml(fmtDate(day.date))}</div>` : ''}
        </div>
      </div>
    </div>
  ` : `
    <div class="accent-bar"></div>
    <div class="eyebrow">Day ${day.num}${day.destination ? ' · ' + escapeHtml(day.destination) : ''}</div>
    <h2 class="section-title">${escapeHtml(day.title || day.destination || `Day ${day.num}`)}</h2>
    ${day.date ? `<p class="section-sub">${escapeHtml(fmtDate(day.date))}</p>` : ''}
  `}

  <div class="day-body">
    ${day.images.length > 1 ? `
      <div class="day-gallery ${day.images.length > 4 ? 'small' : ''}">
        ${day.images.slice(1, 7).map(img => `<img src="${escapeHtml(img.url)}">`).join('')}
      </div>
    ` : ''}
    ${day.transport?.name ? `<div class="day-transport">→ ${escapeHtml(day.transport.name)}${day.transport.estimatedTime ? ' · ' + escapeHtml(day.transport.estimatedTime) : ''}</div>` : ''}
    ${day.narrative ? `<p class="day-narr">${escapeHtml(day.narrative)}</p>` : ''}

    <div class="day-grid">
      <div>
        ${day.activities.length ? `
          <div class="activities">
            <h4>Experiences</h4>
            ${day.activities.map(a => `
              <div class="activity">
                ${a.timeOfDay ? `<div class="activity-time">${escapeHtml(String(a.timeOfDay).replace(/_/g, ' '))}</div>` : '<div class="activity-time"></div>'}
                <div class="activity-body">
                  <div class="activity-name">${escapeHtml(a.name || a.description || '')}</div>
                  ${a.description && a.name && a.description !== a.name ? `<div class="activity-desc">${escapeHtml(a.description)}</div>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${(day.meals?.breakfast || day.meals?.lunch || day.meals?.dinner || day.meals?.notes) ? `
          <div class="meals-block">
            <h4>Meals</h4>
            <div class="meals-row">
              <span class="meal-pill ${day.meals?.breakfast ? '' : 'off'}">${day.meals?.breakfast ? '✓' : '—'} Breakfast</span>
              <span class="meal-pill ${day.meals?.lunch ? '' : 'off'}">${day.meals?.lunch ? '✓' : '—'} Lunch</span>
              <span class="meal-pill ${day.meals?.dinner ? '' : 'off'}">${day.meals?.dinner ? '✓' : '—'} Dinner</span>
            </div>
            ${day.meals?.notes ? `<p style="font-size:10px; color:#78716c; margin-top:8px; line-height:1.5;">${escapeHtml(day.meals.notes)}</p>` : ''}
          </div>
        ` : ''}
      </div>

      <div>
        ${day.hotel?.name ? `
          <div class="hotel-card">
            ${day.hotel.images?.[0]?.url ? `<img class="hotel-img" src="${escapeHtml(day.hotel.images[0].url)}">` : ''}
            <div class="hotel-body">
              <div class="hotel-eyebrow">Tonight's Stay</div>
              <div class="hotel-name">${escapeHtml(day.hotel.name)}</div>
              ${day.hotel.roomType ? `<div class="hotel-detail">${escapeHtml(day.hotel.roomType)}</div>` : ''}
              ${day.mealPlan ? `<div class="hotel-detail">${escapeHtml(mealLabels[day.mealPlan] || day.mealPlan)}</div>` : ''}
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  </div>

  <div class="footer">
    <span>Day ${day.num} of ${totalDays}</span>
    <span>${escapeHtml(brand.companyName || '')} · Quote #${escapeHtml(quote.quoteNumber || '—')}</span>
  </div>
</div>
`).join('') : ''}

<!-- ═══ ACCOMMODATIONS ═══ -->
${blockOn('accommodations') && uniqueHotels.length ? `
<div class="page">
  <div class="accent-bar"></div>
  <div class="eyebrow">Where You'll Stay</div>
  <h2 class="section-title">Accommodations</h2>
  <p class="section-sub">Handpicked lodges and camps for your journey</p>

  <div class="acc-grid">
    ${uniqueHotels.map(h => `
      <div class="acc-card">
        ${h.images?.[0]?.url ? `<img class="acc-img" src="${escapeHtml(h.images[0].url)}">` : '<div class="acc-img"></div>'}
        <div class="acc-body">
          <div class="acc-name">${escapeHtml(h.name)}</div>
          <div class="acc-meta">
            ${h.roomType ? escapeHtml(h.roomType) : ''}
            ${h.mealPlan ? (h.roomType ? ' · ' : '') + escapeHtml(mealLabels[h.mealPlan] || h.mealPlan) : ''}
          </div>
        </div>
      </div>
    `).join('')}
  </div>

  <div class="footer">
    <span>Quote #${escapeHtml(quote.quoteNumber || '—')}</span>
    <span>${escapeHtml(brand.companyName || '')}</span>
  </div>
</div>` : ''}

<!-- ═══ PRICING ═══ -->
${blockOn('pricing') ? `
<div class="page">
  <div class="accent-bar"></div>
  <div class="eyebrow">Investment</div>
  <h2 class="section-title">Your Journey</h2>
  <p class="section-sub">All prices in ${escapeHtml(quote.pricing?.currency || 'USD')}</p>

  <div class="price-grid">
    <div>
      ${quote.pricing?.displayMode === 'line_items' && quote.pricing?.lineItems?.length ? `
        <table class="price-table">
          <thead>
            <tr>
              <th>Description</th>
              <th style="text-align:center; width:50px;">Qty</th>
              <th style="text-align:right; width:80px;">Unit</th>
              <th style="text-align:right; width:90px;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${quote.pricing.lineItems.map(item => `
              <tr>
                <td>${escapeHtml(item.description || '')}</td>
                <td style="text-align:center;">${item.quantity || 1}</td>
                <td style="text-align:right;">${escapeHtml(fmtCurrency(item.unitPrice, quote.pricing.currency))}</td>
                <td style="text-align:right; font-weight:600;">${escapeHtml(fmtCurrency(item.total, quote.pricing.currency))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : `
        <div style="padding:18px 0; border-bottom:1px solid #e7e5e4;">
          <div style="font-size:11px; color:#78716c; margin-bottom:4px;">${totalDays} days · ${totalPax} ${totalPax === 1 ? 'traveler' : 'travelers'}</div>
          <div style="font-size:13px; font-weight:600;">${escapeHtml(quote.title || 'Complete Package')}</div>
        </div>
      `}

      <div class="total-row">
        <span class="total-lbl">Total</span>
        <span class="total-val">${escapeHtml(fmtCurrency(quote.pricing?.totalPrice, quote.pricing?.currency))}</span>
      </div>
      ${totalPax > 0 && quote.pricing?.perPersonPrice ? `<p class="per-person">${escapeHtml(fmtCurrency(quote.pricing.perPersonPrice, quote.pricing?.currency))} per person</p>` : ''}

      ${quote.paymentTerms && blockOn('payment_terms') ? `
        <div class="terms-box">
          <div class="terms-box-label">Payment Terms</div>
          <div class="terms-body">${escapeHtml(quote.paymentTerms)}</div>
        </div>
      ` : ''}
    </div>

    <div class="side-card">
      <div class="side-row">
        <div class="side-label">Tour Type</div>
        <div class="side-value">${escapeHtml((quote.tourType || 'private').charAt(0).toUpperCase() + (quote.tourType || 'private').slice(1))} Tour</div>
      </div>
      <div class="side-row">
        <div class="side-label">Duration</div>
        <div class="side-value">${totalDays} Days / ${totalNights} Nights</div>
      </div>
      <div class="side-row">
        <div class="side-label">Travelers</div>
        <div class="side-value">${totalPax} ${totalPax === 1 ? 'Guest' : 'Guests'}${quote.travelers?.children ? ` (${quote.travelers.adults} adults, ${quote.travelers.children} children)` : ''}</div>
      </div>
      <div class="side-row">
        <div class="side-label">Departure</div>
        <div class="side-value">${quote.startDate ? escapeHtml(fmtDateShort(quote.startDate)) : 'TBD'}</div>
      </div>
      <div class="side-row">
        <div class="side-label">Return</div>
        <div class="side-value">${quote.endDate ? escapeHtml(fmtDateShort(quote.endDate)) : 'TBD'}</div>
      </div>
    </div>
  </div>

  <div class="inc-exc">
    ${blockOn('inclusions') && quote.inclusions?.length ? `
      <div class="inc-col">
        <h4>What's Included</h4>
        ${quote.inclusions.map(i => `<div class="inc-item"><span class="inc-tick">✓</span><span>${escapeHtml(i)}</span></div>`).join('')}
      </div>
    ` : '<div></div>'}
    ${blockOn('exclusions') && quote.exclusions?.length ? `
      <div class="inc-col">
        <h4>Not Included</h4>
        ${quote.exclusions.map(e => `<div class="inc-item"><span class="exc-tick">✕</span><span>${escapeHtml(e)}</span></div>`).join('')}
      </div>
    ` : '<div></div>'}
  </div>

  <div class="footer">
    <span>Quote #${escapeHtml(quote.quoteNumber || '—')}</span>
    <span>${escapeHtml(brand.companyName || '')}${brand.companyEmail ? ' · ' + escapeHtml(brand.companyEmail) : ''}</span>
  </div>
</div>` : ''}

<!-- ═══ CLOSING ═══ -->
<div class="page no-pad">
  <div class="closing">
    ${brand.logo ? `<img class="closing-logo" src="${escapeHtml(brand.logo)}">` : ''}
    <h2 class="closing-name">${escapeHtml(brand.companyName || 'Thank You')}</h2>
    <div class="closing-contact">
      ${brand.companyEmail ? `<div>${escapeHtml(brand.companyEmail)}</div>` : ''}
      ${brand.companyPhone ? `<div>${escapeHtml(brand.companyPhone)}</div>` : ''}
      ${brand.companyAddress ? `<div>${escapeHtml(brand.companyAddress)}</div>` : ''}
    </div>

    ${brand.aboutUs ? `
      <p style="font-size:11px; color:#57534e; max-width:130mm; margin-top:22px; line-height:1.7; white-space:pre-line;">${escapeHtml(brand.aboutUs)}</p>
    ` : ''}

    ${quote.createdBy?.name ? `
      <div class="sig-block">
        ${quote.signatureNote || quote.closingNote ? `<p class="sig-note">${escapeHtml(quote.signatureNote || quote.closingNote)}</p>` : `<p class="sig-note">It would be a privilege to bring this journey to life for you. I'm here to answer any questions and tailor anything you'd like to adjust.</p>`}
        ${quote.createdBy.signature ? `<img class="sig-image" src="${escapeHtml(quote.createdBy.signature)}">` : `<div class="sig-handwritten">${escapeHtml(quote.createdBy.name.split(' ')[0])}</div>`}
        <div class="sig-author">
          ${quote.createdBy.avatar ? `<img class="sig-avatar" src="${escapeHtml(quote.createdBy.avatar)}">` : ''}
          <div class="sig-meta">
            <div class="sig-name">${escapeHtml(quote.createdBy.name)}</div>
            <div class="sig-title">${escapeHtml(quote.createdBy.jobTitle || 'Travel Designer')}${brand.companyName ? ' · ' + escapeHtml(brand.companyName) : ''}</div>
          </div>
        </div>
      </div>
    ` : (quote.closingNote ? `<p style="font-size:12px; color:#44403c; max-width:120mm; margin-top:32px; line-height:1.7; font-style:italic;">${escapeHtml(quote.closingNote)}</p>` : '')}

    ${(() => {
      const q = brand.coverQuote || "One's destination is never a place, but a new way of seeing things.";
      const author = brand.coverQuote ? (brand.coverQuoteAuthor || '') : 'Henry Miller';
      return `<p class="closing-quote">"${escapeHtml(q)}"${author ? `<br><span style="font-size:10px; letter-spacing:2px; text-transform:uppercase; font-style:normal; color:#d6d3d1;">— ${escapeHtml(author)}</span>` : ''}</p>`;
    })()}
  </div>
</div>

${quote.status === 'draft' ? `<script>
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.page, .cover').forEach(el => {
      const s = document.createElement('div');
      s.className = 'draft-stamp';
      s.textContent = 'DRAFT';
      el.appendChild(s);
    });
  });
  // Fire immediately too since Puppeteer may already be past DOMContentLoaded
  if (document.readyState !== 'loading') document.dispatchEvent(new Event('DOMContentLoaded'));
</script>` : ''}

</body>
</html>`;
}

// Fill in cover quote from current org branding when the snapshot is missing it
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

// Hydrate hotel images from the Hotel collection when the day snapshot is missing them
async function hydrateHotelImages(quote) {
  const needsImages = (quote.days || []).filter(d => d.hotel?.name && !d.hotel.images?.length);
  if (!needsImages.length) return;

  const ids = [...new Set(needsImages.map(d => d.hotel.hotelId || d.hotel._id).filter(Boolean).map(String))];
  const names = [...new Set(needsImages.map(d => d.hotel.name).filter(Boolean))];

  const orConds = [];
  if (ids.length) orConds.push({ _id: { $in: ids } });
  if (names.length) orConds.push({ organization: quote.organization, name: { $in: names } });
  if (!orConds.length) return;

  const hotels = await Hotel.find({ $or: orConds }).select('name images').lean();
  const byId = new Map(hotels.map(h => [String(h._id), h.images || []]));
  const byName = new Map(hotels.map(h => [h.name, h.images || []]));

  for (const d of needsImages) {
    const id = d.hotel.hotelId || d.hotel._id;
    const imgs = (id && byId.get(String(id))) || byName.get(d.hotel.name) || [];
    if (imgs.length) d.hotel.images = imgs;
  }
}

// HTML preview endpoint
router.get('/:id/pdf', protect, async (req, res) => {
  try {
    const quote = await Quote.findOne({ _id: req.params.id, organization: req.organizationId })
      .populate('contact')
      .populate('createdBy', 'name email phone jobTitle avatar signature signatureNote');
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    await hydrateBranding(quote);
    await hydrateHotelImages(quote);
    const html = buildHtml(quote);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Puppeteer-based download
router.get('/:id/pdf/download', protect, async (req, res) => {
  try {
    const quote = await Quote.findOne({ _id: req.params.id, organization: req.organizationId })
      .populate('contact')
      .populate('createdBy', 'name email phone jobTitle avatar signature signatureNote');
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    await hydrateBranding(quote);
    await hydrateHotelImages(quote);

    // Cache hit? Return immediately.
    const cacheKey = `${quote._id}:${quote.updatedAt?.getTime()}:${quote.pdfStyle || ''}:${quote.coverLayout || ''}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="quote-${quote.quoteNumber || req.params.id}.pdf"`);
      return res.send(cached);
    }

    const html = buildHtml(quote);

    let browser;
    try {
      browser = await getBrowser();
    } catch (err) {
      console.error('[pdf/download] puppeteer launch failed:', err);
      return res.status(500).json({ message: 'Failed to generate PDF', error: err.message });
    }

    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Fonts: wait up to 2s
      await Promise.race([
        page.evaluate(() => document.fonts?.ready),
        new Promise(r => setTimeout(r, 2000)),
      ]);
      // Images: wait up to 6s total for pending images (whichever comes first)
      await Promise.race([
        page.evaluate(() => Promise.all(
          Array.from(document.images)
            .filter(img => !img.complete)
            .map(img => new Promise(res => { img.onload = img.onerror = res; }))
        )),
        new Promise(r => setTimeout(r, 6000)),
      ]);
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      cacheSet(cacheKey, pdf);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="quote-${quote.quoteNumber || req.params.id}.pdf"`);
      res.send(pdf);
    } finally {
      await page.close();
    }
  } catch (error) {
    console.error('[pdf/download] error:', error);
    res.status(500).json({ message: error.message, stack: error.stack });
  }
});

export default router;
