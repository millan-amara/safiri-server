import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import Quote from '../models/Quote.js';
import Organization from '../models/Organization.js';

const router = Router();

// Generate PDF from quote data — renders a self-contained HTML template
router.get('/:id/pdf', protect, async (req, res) => {
  try {
    const quote = await Quote.findOne({ _id: req.params.id, organization: req.organizationId })
      .populate('contact');

    if (!quote) return res.status(404).json({ message: 'Quote not found' });

    const org = await Organization.findById(req.organizationId);
    const brand = quote.brandingSnapshot || {};
    const primaryColor = brand.primaryColor || org?.branding?.primaryColor || '#B45309';

    const totalNights = quote.segments?.reduce((s, seg) => s + seg.nights, 0) || 0;
    const totalDays = totalNights + 1;
    const totalPax = (quote.travelers?.adults || 0) + (quote.travelers?.children || 0);

    const mealLabels = { RO: 'Room Only', BB: 'Bed & Breakfast', HB: 'Half Board', FB: 'Full Board', AI: 'All Inclusive' };

    const fmtCurrency = (amt, cur = 'USD') => {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 0 }).format(amt || 0);
    };

    const fmtDate = (d) => {
      if (!d) return '';
      return new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    };

    // Build day list
    const days = [];
    let dayNum = 1;
    let curDate = quote.startDate ? new Date(quote.startDate) : null;
    for (const seg of (quote.segments || [])) {
      for (let n = 0; n < seg.nights; n++) {
        days.push({
          num: dayNum, date: curDate ? new Date(curDate) : null,
          destination: seg.destination, hotel: seg.hotel,
          narrative: n === 0 ? seg.narrative : '',
          transport: n === 0 ? seg.transport : null,
          activities: seg.activities || [],
          mealPlan: seg.hotel?.mealPlan,
          isFirst: n === 0,
        });
        dayNum++;
        if (curDate) curDate.setDate(curDate.getDate() + 1);
      }
    }

    // Summary rows
    const summaryRows = (quote.segments || []).map((seg, i) => {
      const start = (quote.segments || []).slice(0, i).reduce((s, p) => s + p.nights, 0) + 1;
      const end = start + seg.nights - 1;
      return { start, end, seg };
    });

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Playfair+Display:wght@500;600;700&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'DM Sans', system-ui, sans-serif; color: #1c1917; font-size: 11px; line-height: 1.5; }
  h1, h2, h3 { font-family: 'Playfair Display', serif; }

  .page { page-break-after: always; padding: 48px; min-height: 100vh; position: relative; }
  .page:last-child { page-break-after: auto; }

  /* Cover */
  .cover { display: flex; flex-direction: column; justify-content: flex-end; background: linear-gradient(135deg, ${primaryColor}12 0%, transparent 60%); }
  .cover-badge { display: inline-block; font-size: 10px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: ${primaryColor}; margin-bottom: 16px; }
  .cover h1 { font-size: 36px; font-weight: 700; line-height: 1.15; margin-bottom: 16px; color: #1c1917; }
  .cover-narrative { font-size: 12px; color: #57534e; max-width: 500px; line-height: 1.6; margin-bottom: 32px; }

  .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; max-width: 560px; }
  .meta-card { background: white; border: 1px solid #e7e5e4; border-radius: 8px; padding: 10px; }
  .meta-label { font-size: 8px; text-transform: uppercase; letter-spacing: 1px; color: #a8a29e; font-weight: 600; margin-bottom: 2px; }
  .meta-value { font-size: 11px; font-weight: 600; color: #1c1917; }

  /* Summary */
  .summary-row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; border-bottom: 1px solid #f5f5f4; }
  .day-badge { width: 28px; height: 28px; border-radius: 50%; background: ${primaryColor}; color: white; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; flex-shrink: 0; }
  .summary-dest { font-size: 12px; font-weight: 600; color: #1c1917; }
  .summary-detail { font-size: 10px; color: #78716c; }

  /* Day detail */
  .day-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid ${primaryColor}20; }
  .day-num { width: 44px; height: 44px; border-radius: 10px; background: ${primaryColor}; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0; }
  .day-num-label { font-size: 7px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.8; }
  .day-num-val { font-size: 18px; font-weight: 700; margin-top: -2px; }

  .day-content { display: grid; grid-template-columns: 1fr 200px; gap: 24px; }
  .activity-item { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 4px; }
  .activity-dot { width: 5px; height: 5px; border-radius: 50%; background: ${primaryColor}; margin-top: 5px; flex-shrink: 0; }

  .hotel-card { background: ${primaryColor}06; border: 1px solid ${primaryColor}20; border-radius: 8px; padding: 10px; }
  .hotel-label { font-size: 8px; text-transform: uppercase; letter-spacing: 1px; color: ${primaryColor}; font-weight: 600; margin-bottom: 4px; }
  .hotel-name { font-size: 11px; font-weight: 600; color: #1c1917; }
  .hotel-detail { font-size: 9px; color: #78716c; margin-top: 2px; }

  /* Pricing */
  .price-table { width: 100%; border-collapse: collapse; }
  .price-table th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #a8a29e; font-weight: 600; padding: 6px 0; border-bottom: 1px solid #e7e5e4; }
  .price-table td { padding: 8px 0; border-bottom: 1px solid #f5f5f4; font-size: 11px; }
  .price-total { font-size: 24px; font-weight: 700; color: ${primaryColor}; }

  .inc-exc { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 20px; }
  .inc-item { font-size: 10px; color: #57534e; padding: 2px 0; }
  .inc-icon { color: #22c55e; margin-right: 4px; }
  .exc-icon { color: #a8a29e; margin-right: 4px; }

  .section-title { font-size: 18px; font-weight: 700; color: #1c1917; margin-bottom: 16px; }
  .transport-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 9px; background: #f5f5f4; color: #78716c; padding: 3px 8px; border-radius: 4px; margin-bottom: 8px; }

  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e7e5e4; display: flex; justify-content: space-between; font-size: 9px; color: #a8a29e; }
  .accent-bar { width: 40px; height: 3px; background: ${primaryColor}; border-radius: 2px; margin-bottom: 12px; }
</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="page cover">
  ${brand.logo ? `<img src="${brand.logo}" style="height:40px; margin-bottom:32px; object-fit:contain;">` : ''}
  <span class="cover-badge">${brand.companyName || ''}</span>
  <p style="font-size:12px; color:#78716c; margin-bottom:4px;">Proposal for ${quote.contact?.firstName || ''} ${quote.contact?.lastName || ''}</p>
  <h1>${quote.title || 'Travel Proposal'}</h1>
  ${quote.coverNarrative ? `<p class="cover-narrative">${quote.coverNarrative}</p>` : ''}
  <div class="meta-grid">
    <div class="meta-card"><div class="meta-label">Duration</div><div class="meta-value">${totalDays} Days / ${totalNights} Nights</div></div>
    <div class="meta-card"><div class="meta-label">Travelers</div><div class="meta-value">${totalPax} Traveler${totalPax !== 1 ? 's' : ''}</div></div>
    <div class="meta-card"><div class="meta-label">Start</div><div class="meta-value">${quote.startDate ? fmtDate(quote.startDate).split(',').slice(1).join(',').trim() : 'TBD'}</div></div>
    <div class="meta-card"><div class="meta-label">Tour Type</div><div class="meta-value">${(quote.tourType || 'Private').charAt(0).toUpperCase() + (quote.tourType || 'private').slice(1)} Tour</div></div>
  </div>
  <div class="footer">
    <span>Quote #${quote.quoteNumber || ''}</span>
    <span>${brand.companyName || ''} ${brand.companyPhone ? '· ' + brand.companyPhone : ''}</span>
  </div>
</div>

<!-- SUMMARY PAGE -->
<div class="page">
  <div class="accent-bar"></div>
  <h2 class="section-title">Itinerary Summary</h2>
  <p style="font-size:11px; color:#78716c; margin-bottom:20px;">
    Start: <strong>${quote.startPoint || 'Nairobi'}</strong>
    ${quote.startDate ? ` · ${fmtDate(quote.startDate)}` : ''}
  </p>
  ${summaryRows.map(({ start, end, seg }) => `
    <div class="summary-row">
      <div class="day-badge">${start}${end !== start ? '-' + end : ''}</div>
      <div>
        <div class="summary-dest">${seg.destination}</div>
        <div class="summary-detail">
          ${seg.hotel?.name || 'TBD'} · ${seg.nights} night${seg.nights !== 1 ? 's' : ''}
          ${seg.hotel?.mealPlan ? ' · ' + (mealLabels[seg.hotel.mealPlan] || seg.hotel.mealPlan) : ''}
        </div>
        ${seg.transport?.name ? `<div class="summary-detail" style="margin-top:2px;">↗ ${seg.transport.name}${seg.transport.estimatedTime ? ' (' + seg.transport.estimatedTime + ')' : ''}</div>` : ''}
      </div>
    </div>
  `).join('')}
  <p style="font-size:11px; color:#78716c; margin-top:16px;">
    End: <strong>${quote.endPoint || 'Nairobi'}</strong>
    ${quote.endDate ? ` · ${fmtDate(quote.endDate)}` : ''}
  </p>
  ${quote.highlights?.length ? `
    <div style="margin-top:24px; padding:12px; background:${primaryColor}06; border-radius:8px; border:1px solid ${primaryColor}15;">
      <div style="font-size:9px; text-transform:uppercase; letter-spacing:1px; color:${primaryColor}; font-weight:600; margin-bottom:6px;">Trip Highlights</div>
      <div style="display:flex; flex-wrap:wrap; gap:6px;">
        ${quote.highlights.map(h => `<span style="font-size:10px; background:white; border:1px solid ${primaryColor}20; padding:2px 8px; border-radius:12px; color:#57534e;">★ ${h}</span>`).join('')}
      </div>
    </div>
  ` : ''}
  <div class="footer">
    <span>Quote #${quote.quoteNumber || ''}</span>
    <span>${brand.companyName || ''}</span>
  </div>
</div>

<!-- DAY-BY-DAY PAGES -->
${days.map((day, i) => `
${i > 0 && i % 3 === 0 ? '</div><div class="page">' : (i === 0 ? '<div class="page">' : '')}
${i === 0 ? '<div class="accent-bar"></div><h2 class="section-title">Day by Day</h2>' : ''}
<div style="margin-bottom:20px; ${i > 0 && i % 3 === 0 ? 'padding-top:8px;' : ''}">
  <div class="day-header">
    <div class="day-num">
      <span class="day-num-label">Day</span>
      <span class="day-num-val">${day.num}</span>
    </div>
    <div>
      <div style="font-size:14px; font-weight:600;">${day.destination}</div>
      ${day.date ? `<div style="font-size:10px; color:#78716c;">${fmtDate(day.date)}</div>` : ''}
    </div>
  </div>
  ${day.transport ? `<div class="transport-badge">→ ${day.transport.name}${day.transport.estimatedTime ? ' · ' + day.transport.estimatedTime : ''}</div>` : ''}
  <div class="day-content">
    <div>
      ${day.narrative ? `<p style="font-size:11px; color:#57534e; line-height:1.6; margin-bottom:8px;">${day.narrative}</p>` : ''}
      ${day.activities.length ? `
        <div style="margin-top:4px;">
          ${day.activities.map(a => `
            <div class="activity-item">
              <div class="activity-dot"></div>
              <span style="font-size:10px; color:#44403c;">${a.name || a.description || ''}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
    <div>
      ${day.hotel?.name ? `
        <div class="hotel-card">
          <div class="hotel-label">Accommodation</div>
          <div class="hotel-name">${day.hotel.name}</div>
          ${day.hotel.roomType ? `<div class="hotel-detail">${day.hotel.roomType}</div>` : ''}
          ${day.mealPlan ? `<div class="hotel-detail">${mealLabels[day.mealPlan] || day.mealPlan}</div>` : ''}
        </div>
      ` : ''}
    </div>
  </div>
</div>
${i === days.length - 1 ? '<div class="footer"><span>Quote #' + (quote.quoteNumber || '') + '</span><span>' + (brand.companyName || '') + '</span></div></div>' : ''}
`).join('')}

<!-- PRICING PAGE -->
<div class="page">
  <div class="accent-bar"></div>
  <h2 class="section-title">Pricing</h2>
  <div style="display:grid; grid-template-columns:1fr 200px; gap:24px;">
    <div>
      ${quote.pricing?.displayMode === 'line_items' && quote.pricing?.lineItems?.length ? `
        <table class="price-table">
          <thead><tr><th>Description</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Unit</th><th style="text-align:right;">Total</th></tr></thead>
          <tbody>
            ${quote.pricing.lineItems.map(item => `
              <tr>
                <td>${item.description}</td>
                <td style="text-align:center;">${item.quantity}</td>
                <td style="text-align:right;">${fmtCurrency(item.unitPrice, quote.pricing.currency)}</td>
                <td style="text-align:right; font-weight:600;">${fmtCurrency(item.total, quote.pricing.currency)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : ''}
      <div style="margin-top:16px; padding-top:12px; border-top:2px solid #1c1917; display:flex; justify-content:space-between; align-items:baseline;">
        <span style="font-size:14px; font-weight:700;">Total</span>
        <span class="price-total">${fmtCurrency(quote.pricing?.totalPrice, quote.pricing?.currency)}</span>
      </div>
      ${totalPax > 0 ? `<p style="text-align:right; font-size:10px; color:#a8a29e; margin-top:2px;">${fmtCurrency(quote.pricing?.perPersonPrice, quote.pricing?.currency)} per person</p>` : ''}

      ${quote.paymentTerms ? `
        <div style="margin-top:16px; padding:10px; background:#f5f5f4; border-radius:8px;">
          <div style="font-size:9px; text-transform:uppercase; letter-spacing:0.5px; color:#78716c; font-weight:600; margin-bottom:3px;">Payment Terms</div>
          <p style="font-size:10px; color:#44403c;">${quote.paymentTerms}</p>
        </div>
      ` : ''}
    </div>
    <div>
      <div style="background:${primaryColor}06; border:1px solid ${primaryColor}15; border-radius:8px; padding:12px;">
        <div class="meta-label">Tour Type</div><div class="meta-value" style="margin-bottom:8px;">${(quote.tourType || 'Private').charAt(0).toUpperCase() + (quote.tourType || 'private').slice(1)} Tour</div>
        <div class="meta-label">Duration</div><div class="meta-value" style="margin-bottom:8px;">${totalDays} Days / ${totalNights} Nights</div>
        <div class="meta-label">Start</div><div class="meta-value" style="margin-bottom:8px;">${quote.startDate ? fmtDate(quote.startDate).split(',').slice(1).join(',').trim() : 'TBD'}</div>
        <div class="meta-label">Travelers</div><div class="meta-value">${totalPax} Traveler${totalPax !== 1 ? 's' : ''}</div>
      </div>
    </div>
  </div>

  <div class="inc-exc">
    ${quote.inclusions?.length ? `
      <div>
        <div style="font-size:10px; font-weight:600; color:#1c1917; margin-bottom:6px;">✓ Included</div>
        ${quote.inclusions.map(i => `<div class="inc-item"><span class="inc-icon">→</span>${i}</div>`).join('')}
      </div>
    ` : '<div></div>'}
    ${quote.exclusions?.length ? `
      <div>
        <div style="font-size:10px; font-weight:600; color:#1c1917; margin-bottom:6px;">— Excluded</div>
        ${quote.exclusions.map(e => `<div class="inc-item"><span class="exc-icon">→</span>${e}</div>`).join('')}
      </div>
    ` : '<div></div>'}
  </div>

  <div class="footer">
    <span>Quote #${quote.quoteNumber || ''}</span>
    <span>${brand.companyName || ''} ${brand.companyEmail ? '· ' + brand.companyEmail : ''}</span>
  </div>
</div>

<!-- ABOUT PAGE -->
<div class="page" style="display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center;">
  ${brand.logo ? `<img src="${brand.logo}" style="height:48px; margin-bottom:24px; object-fit:contain;">` : ''}
  <h2 style="font-family:'Playfair Display',serif; font-size:24px; margin-bottom:12px;">${brand.companyName || ''}</h2>
  ${brand.companyEmail ? `<p style="font-size:11px; color:#78716c;">${brand.companyEmail}</p>` : ''}
  ${brand.companyPhone ? `<p style="font-size:11px; color:#78716c;">${brand.companyPhone}</p>` : ''}
  ${brand.companyAddress ? `<p style="font-size:11px; color:#78716c; margin-top:4px;">${brand.companyAddress}</p>` : ''}
  ${quote.closingNote ? `<p style="font-size:12px; color:#57534e; max-width:400px; margin-top:24px; line-height:1.6;">${quote.closingNote}</p>` : ''}
  <p style="font-size:18px; font-style:italic; color:#a8a29e; margin-top:40px; font-family:'Playfair Display',serif;">
    "One's destination is never a place,<br>but a new way of seeing things"
  </p>
  <p style="font-size:10px; color:#a8a29e; margin-top:8px;">— Henry Miller</p>
</div>

</body>
</html>`;

    // Set response as HTML (client can use browser print-to-PDF or we can use Puppeteer)
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Puppeteer-based PDF generation (if puppeteer is installed)
router.get('/:id/pdf/download', protect, async (req, res) => {
  try {
    // Get HTML from the above endpoint internally
    const protocol = req.protocol;
    const host = req.get('host');
    const token = req.headers.authorization;

    const htmlRes = await fetch(`${protocol}://${host}/api/pdf/${req.params.id}/pdf`, {
      headers: { Authorization: token },
    });
    const html = await htmlRes.text();

    // Try puppeteer
    let puppeteer;
    try {
      puppeteer = await import('puppeteer');
    } catch {
      // Puppeteer not installed — return HTML with print instructions
      return res.setHeader('Content-Type', 'text/html').send(
        html.replace('</head>', `<script>window.onload=()=>window.print();</script></head>`)
      );
    }

    const browser = await puppeteer.default.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="quote-${req.params.id}.pdf"`);
    res.send(pdf);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;