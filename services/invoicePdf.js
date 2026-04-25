import PDFDocument from 'pdfkit';

// Fetch the org logo as a Buffer for pdfkit to embed. Returns null on any
// failure so the PDF still renders without it.
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

function formatMoney(amount, currency) {
  const n = Number(amount) || 0;
  return `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtInvoiceNumber(n) {
  return `INV-${String(n).padStart(4, '0')}`;
}

// Build an invoice PDF as a Buffer using pdfkit. No headless browser, so the
// memory footprint is ~5MB per render instead of ~150MB for puppeteer.
export async function buildInvoicePdf(invoice, org) {
  const logoBuffer = await fetchLogoBuffer(org?.branding?.logo);
  const accent = org?.branding?.primaryColor || '#0f172a';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header: logo (left) + invoice meta (right) ─────────────────────────
    const headerY = 50;
    if (logoBuffer) {
      try { doc.image(logoBuffer, 50, headerY, { fit: [140, 60] }); }
      catch { /* malformed image — skip */ }
    } else {
      doc.font('Helvetica-Bold').fontSize(18).fillColor(accent).text(org?.name || 'Invoice', 50, headerY);
    }

    doc.font('Helvetica-Bold').fontSize(22).fillColor(accent)
      .text('INVOICE', 350, headerY, { width: 195, align: 'right' });
    doc.font('Helvetica').fontSize(11).fillColor('#374151')
      .text(fmtInvoiceNumber(invoice.invoiceNumber), 350, headerY + 28, { width: 195, align: 'right' });

    doc.fontSize(9).fillColor('#6b7280');
    doc.text(`Issued: ${formatDate(invoice.issueDate)}`, 350, headerY + 48, { width: 195, align: 'right' });
    if (invoice.dueDate) {
      doc.text(`Due: ${formatDate(invoice.dueDate)}`, 350, headerY + 62, { width: 195, align: 'right' });
    }

    // ── Issuer block (under logo) ─────────────────────────────────────────
    let cursorY = headerY + 75;
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    if (org?.name && logoBuffer) {
      doc.text(org.name, 50, cursorY); cursorY += 12;
    }
    if (org?.businessInfo?.address) { doc.text(org.businessInfo.address, 50, cursorY); cursorY += 12; }
    if (org?.businessInfo?.email)   { doc.text(org.businessInfo.email,   50, cursorY); cursorY += 12; }
    if (org?.businessInfo?.phone)   { doc.text(org.businessInfo.phone,   50, cursorY); cursorY += 12; }
    if (org?.businessInfo?.website) { doc.text(org.businessInfo.website, 50, cursorY); cursorY += 12; }

    // ── Bill-to block ─────────────────────────────────────────────────────
    const billY = Math.max(cursorY + 25, 200);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#9ca3af')
      .text('BILL TO', 50, billY, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
      .text(invoice.client?.name || '(no name on file)', 50, billY + 14);

    let billCursor = billY + 30;
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    if (invoice.client?.company) { doc.text(invoice.client.company, 50, billCursor); billCursor += 12; }
    if (invoice.client?.email)   { doc.text(invoice.client.email,   50, billCursor); billCursor += 12; }
    if (invoice.client?.phone)   { doc.text(invoice.client.phone,   50, billCursor); billCursor += 12; }
    if (invoice.client?.address) { doc.text(invoice.client.address, 50, billCursor); billCursor += 12; }

    // ── Line items table ──────────────────────────────────────────────────
    const tableTop = Math.max(billCursor + 30, 320);
    const cols = { desc: 50, qty: 340, price: 400, total: 480 };
    const rightEdge = 550;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280');
    doc.text('DESCRIPTION', cols.desc, tableTop, { characterSpacing: 0.5 });
    doc.text('QTY',         cols.qty,  tableTop, { width: 50, align: 'right' });
    doc.text('UNIT PRICE',  cols.price, tableTop, { width: 70, align: 'right' });
    doc.text('TOTAL',       cols.total, tableTop, { width: 60, align: 'right' });
    doc.strokeColor('#e5e7eb').lineWidth(0.5)
      .moveTo(50, tableTop + 14).lineTo(rightEdge, tableTop + 14).stroke();

    let rowY = tableTop + 22;
    doc.font('Helvetica').fontSize(10).fillColor('#111827');
    for (const item of (invoice.lineItems || [])) {
      // Wrap description to its column; use heightOfString for variable-row layout.
      const descHeight = doc.heightOfString(item.description || '', { width: 270 });
      const rowHeight = Math.max(20, descHeight + 6);
      doc.text(item.description || '', cols.desc, rowY, { width: 270 });
      doc.text(String(item.quantity || 1), cols.qty, rowY, { width: 50, align: 'right' });
      doc.text(formatMoney(item.unitPrice, invoice.currency), cols.price, rowY, { width: 70, align: 'right' });
      doc.text(formatMoney(item.total, invoice.currency), cols.total, rowY, { width: 60, align: 'right' });
      rowY += rowHeight;

      // Page break if we're getting close to the bottom.
      if (rowY > 720) { doc.addPage(); rowY = 50; }
    }

    // ── Totals ────────────────────────────────────────────────────────────
    rowY += 10;
    doc.strokeColor('#e5e7eb').lineWidth(0.5)
      .moveTo(cols.qty - 10, rowY).lineTo(rightEdge, rowY).stroke();
    rowY += 10;

    doc.font('Helvetica').fontSize(10).fillColor('#374151');
    doc.text('Subtotal', cols.price, rowY, { width: 70, align: 'right' });
    doc.text(formatMoney(invoice.subtotal, invoice.currency), cols.total, rowY, { width: 60, align: 'right' });
    rowY += 16;

    if (invoice.taxAmount > 0 || invoice.taxPercent > 0) {
      doc.text(`Tax (${invoice.taxPercent}%)`, cols.price, rowY, { width: 70, align: 'right' });
      doc.text(formatMoney(invoice.taxAmount, invoice.currency), cols.total, rowY, { width: 60, align: 'right' });
      rowY += 16;
    }

    rowY += 4;
    doc.strokeColor(accent).lineWidth(1)
      .moveTo(cols.price - 10, rowY).lineTo(rightEdge, rowY).stroke();
    rowY += 8;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(accent);
    doc.text('TOTAL', cols.price, rowY, { width: 70, align: 'right' });
    doc.text(formatMoney(invoice.total, invoice.currency), cols.total, rowY, { width: 60, align: 'right' });

    // ── Payment instructions + notes ──────────────────────────────────────
    let bottomY = Math.max(rowY + 50, 600);
    if (invoice.paymentInstructions) {
      if (bottomY > 700) { doc.addPage(); bottomY = 50; }
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#9ca3af')
        .text('PAYMENT INSTRUCTIONS', 50, bottomY, { characterSpacing: 0.5 });
      doc.font('Helvetica').fontSize(10).fillColor('#111827')
        .text(invoice.paymentInstructions, 50, bottomY + 14, { width: 500 });
      bottomY += 20 + doc.heightOfString(invoice.paymentInstructions, { width: 500 });
    }

    if (invoice.notes) {
      bottomY += 16;
      if (bottomY > 700) { doc.addPage(); bottomY = 50; }
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#9ca3af')
        .text('NOTES', 50, bottomY, { characterSpacing: 0.5 });
      doc.font('Helvetica').fontSize(10).fillColor('#111827')
        .text(invoice.notes, 50, bottomY + 14, { width: 500 });
    }

    // Footer
    doc.font('Helvetica').fontSize(8).fillColor('#9ca3af')
      .text('Thank you for your business.', 50, 780, { align: 'center', width: 500 });

    doc.end();
  });
}

export { fmtInvoiceNumber };
