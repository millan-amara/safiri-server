import PDFDocument from 'pdfkit';

async function fetchLogoBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtVoucherNumber(n) {
  return `VCH-${String(n).padStart(4, '0')}`;
}

// Voucher PDF — single-page A4, pdfkit (no headless browser). Mirrors the
// look of invoicePdf.js so both documents from the same operator feel like a
// set.
export async function buildVoucherPdf(voucher, org) {
  const logoBuffer = await fetchLogoBuffer(org?.branding?.logo);
  const accent = org?.branding?.primaryColor || '#0f172a';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = 595;  // A4 in pt
    const left = 50;
    const right = pageWidth - 50;

    // ── Header: logo (left) + voucher meta (right) ────────────────────────
    const headerY = 50;
    if (logoBuffer) {
      try { doc.image(logoBuffer, left, headerY, { fit: [140, 60] }); }
      catch { /* malformed image — skip */ }
    } else {
      doc.font('Helvetica-Bold').fontSize(18).fillColor(accent).text(org?.name || 'Voucher', left, headerY);
    }

    doc.font('Helvetica-Bold').fontSize(22).fillColor(accent)
      .text('HOTEL VOUCHER', 350, headerY, { width: 195, align: 'right' });
    doc.font('Helvetica').fontSize(11).fillColor('#374151')
      .text(fmtVoucherNumber(voucher.voucherNumber), 350, headerY + 28, { width: 195, align: 'right' });

    doc.fontSize(9).fillColor('#6b7280');
    if (voucher.confirmationNumber) {
      doc.text(`Confirmation: ${voucher.confirmationNumber}`, 350, headerY + 48, { width: 195, align: 'right' });
    }
    if (voucher.bookingReference) {
      doc.text(`Booking ref: ${voucher.bookingReference}`, 350, headerY + 62, { width: 195, align: 'right' });
    }

    // ── Issuer block (under logo) ─────────────────────────────────────────
    let cursorY = headerY + 75;
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    if (org?.name && logoBuffer) {
      doc.text(org.name, left, cursorY); cursorY += 12;
    }
    if (org?.businessInfo?.address) { doc.text(org.businessInfo.address, left, cursorY); cursorY += 12; }
    if (org?.businessInfo?.email)   { doc.text(org.businessInfo.email,   left, cursorY); cursorY += 12; }
    if (org?.businessInfo?.phone)   { doc.text(org.businessInfo.phone,   left, cursorY); cursorY += 12; }

    // ── Two-column block: GUEST | HOTEL ───────────────────────────────────
    const blockY = Math.max(cursorY + 20, 200);
    const colW = 240;
    const col2X = left + colW + 20;

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#9ca3af')
      .text('GUEST', left, blockY, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
      .text(voucher.guest?.name || '(no name on file)', left, blockY + 14);
    let gY = blockY + 30;
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    if (voucher.guest?.email) { doc.text(voucher.guest.email, left, gY); gY += 12; }
    if (voucher.guest?.phone) { doc.text(voucher.guest.phone, left, gY); gY += 12; }
    const partyParts = [];
    if (voucher.adults > 0) partyParts.push(`${voucher.adults} adult${voucher.adults === 1 ? '' : 's'}`);
    if (voucher.children > 0) partyParts.push(`${voucher.children} child${voucher.children === 1 ? '' : 'ren'}`);
    if (partyParts.length) { doc.text(partyParts.join(', '), left, gY); gY += 12; }

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#9ca3af')
      .text('HOTEL', col2X, blockY, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
      .text(voucher.hotel?.name || '(hotel not set)', col2X, blockY + 14, { width: colW });
    let hY = blockY + 30;
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    if (voucher.hotel?.location)     { doc.text(voucher.hotel.location,     col2X, hY, { width: colW }); hY += 12; }
    if (voucher.hotel?.address)      { doc.text(voucher.hotel.address,      col2X, hY, { width: colW }); hY += 12; }
    if (voucher.hotel?.contactEmail) { doc.text(voucher.hotel.contactEmail, col2X, hY, { width: colW }); hY += 12; }
    if (voucher.hotel?.contactPhone) { doc.text(voucher.hotel.contactPhone, col2X, hY, { width: colW }); hY += 12; }

    // ── Stay details table ────────────────────────────────────────────────
    const stayY = Math.max(gY, hY) + 25;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280')
      .text('STAY DETAILS', left, stayY, { characterSpacing: 0.5 });
    doc.strokeColor('#e5e7eb').lineWidth(0.5)
      .moveTo(left, stayY + 14).lineTo(right, stayY + 14).stroke();

    const rows = [
      ['Check-in',  formatDate(voucher.checkIn)],
      ['Check-out', formatDate(voucher.checkOut)],
      ['Nights',    String(voucher.nights || 0)],
      ['Rooms',     `${voucher.rooms || 1} × ${voucher.roomType || 'Standard'}`],
    ];
    if (voucher.mealPlan) rows.push(['Meal plan', voucher.mealPlan]);

    let rowY = stayY + 22;
    doc.font('Helvetica').fontSize(10);
    for (const [label, value] of rows) {
      doc.fillColor('#6b7280').text(label, left, rowY, { width: 120 });
      doc.fillColor('#111827').text(value, left + 130, rowY, { width: 380 });
      rowY += 18;
    }

    // ── Inclusions ────────────────────────────────────────────────────────
    if (voucher.inclusions?.length) {
      rowY += 14;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#9ca3af')
        .text('INCLUSIONS', left, rowY, { characterSpacing: 0.5 });
      rowY += 14;
      doc.font('Helvetica').fontSize(10).fillColor('#111827');
      for (const item of voucher.inclusions) {
        doc.text(`•  ${item}`, left, rowY, { width: right - left });
        rowY += 14;
      }
    }

    // ── Exclusions ────────────────────────────────────────────────────────
    if (voucher.exclusions?.length) {
      rowY += 8;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#9ca3af')
        .text('NOT INCLUDED', left, rowY, { characterSpacing: 0.5 });
      rowY += 14;
      doc.font('Helvetica').fontSize(10).fillColor('#111827');
      for (const item of voucher.exclusions) {
        doc.text(`•  ${item}`, left, rowY, { width: right - left });
        rowY += 14;
      }
    }

    // ── Special requests ──────────────────────────────────────────────────
    if (voucher.specialRequests) {
      rowY += 14;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#9ca3af')
        .text('SPECIAL REQUESTS', left, rowY, { characterSpacing: 0.5 });
      rowY += 14;
      doc.font('Helvetica').fontSize(10).fillColor('#111827')
        .text(voucher.specialRequests, left, rowY, { width: right - left });
      rowY += doc.heightOfString(voucher.specialRequests, { width: right - left }) + 4;
    }

    // ── Notes ─────────────────────────────────────────────────────────────
    if (voucher.notes) {
      rowY += 14;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#9ca3af')
        .text('NOTES', left, rowY, { characterSpacing: 0.5 });
      rowY += 14;
      doc.font('Helvetica').fontSize(10).fillColor('#111827')
        .text(voucher.notes, left, rowY, { width: right - left });
    }

    // ── Footer ────────────────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(8).fillColor('#9ca3af')
      .text(
        `Please present this voucher at check-in. Issued ${voucher.issuedAt ? formatDate(voucher.issuedAt) : 'as draft'}.`,
        left, 780, { align: 'center', width: right - left }
      );

    doc.end();
  });
}
