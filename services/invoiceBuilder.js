import Invoice from '../models/Invoice.js';
import Quote from '../models/Quote.js';

// Resolve the next per-org invoice number. Sorted descending on the unique
// (organization, invoiceNumber) index → cheap. Race tolerance: the index is
// unique, so a concurrent insert collision will throw E11000 and the caller
// can retry. For a 5-team org, contention is essentially nil.
export async function nextInvoiceNumber(organizationId) {
  const last = await Invoice.findOne({ organization: organizationId })
    .sort({ invoiceNumber: -1 })
    .select('invoiceNumber')
    .lean();
  return (last?.invoiceNumber || 0) + 1;
}

// Build the invoice fields from a deal + the org's preferences. Pure function:
// returns a shape ready to pass to Invoice.create(). Caller adds invoiceNumber
// + createdBy. `deal` must come in populated with `contact`.
export async function buildInvoicePayloadFromDeal({ deal, org, taxPercentOverride, dueDateOverride }) {
  // Pick the most recent real (non-template) quote tied to this deal.
  const latestQuote = await Quote.findOne({
    deal: deal._id,
    organization: deal.organization,
    isTemplate: { $ne: true },
  }).sort({ createdAt: -1 }).lean();

  let lineItems;
  if (latestQuote?.pricing?.displayMode === 'line_items'
      && latestQuote?.pricing?.lineItems?.length) {
    lineItems = latestQuote.pricing.lineItems.map(li => ({
      description: li.description || deal.title,
      quantity: Number(li.quantity) || 1,
      unitPrice: Number(li.unitPrice) || 0,
      total: Number(li.total) || (Number(li.quantity) || 1) * (Number(li.unitPrice) || 0),
    }));
  } else if (latestQuote?.pricing?.totalPrice > 0) {
    lineItems = [{
      description: latestQuote.title || deal.title,
      quantity: 1,
      unitPrice: latestQuote.pricing.totalPrice,
      total: latestQuote.pricing.totalPrice,
    }];
  } else {
    lineItems = [{
      description: deal.title,
      quantity: 1,
      unitPrice: Number(deal.value) || 0,
      total: Number(deal.value) || 0,
    }];
  }

  const subtotal = lineItems.reduce((s, li) => s + (Number(li.total) || 0), 0);
  const taxPercent = taxPercentOverride ?? org?.preferences?.defaultTaxPercent ?? 0;
  const taxAmount = Math.round(subtotal * (taxPercent / 100) * 100) / 100;
  const total = subtotal + taxAmount;

  const currency = deal.currency
    || latestQuote?.pricing?.currency
    || org?.defaults?.currency
    || 'USD';

  const client = {
    name: deal.contact
      ? `${deal.contact.firstName || ''} ${deal.contact.lastName || ''}`.trim()
      : '',
    email: deal.contact?.email || '',
    phone: deal.contact?.phone || '',
    company: deal.contact?.company || '',
    address: '',
  };

  return {
    organization: deal.organization,
    deal: deal._id,
    contact: deal.contact?._id || (typeof deal.contact === 'object' ? deal.contact?._id : deal.contact),
    quote: latestQuote?._id || null,
    client,
    issueDate: new Date(),
    dueDate: dueDateOverride || null,
    lineItems,
    subtotal,
    taxPercent,
    taxAmount,
    total,
    currency,
    paymentInstructions: org?.preferences?.paymentInstructions || '',
  };
}
