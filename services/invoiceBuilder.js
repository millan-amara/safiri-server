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

// Build a deposit + balance pair from a deal. Reuses buildInvoicePayloadFromDeal
// to get the base totals/currency/client snapshot, then derives two payloads
// with adjusted line items, due dates, and the `type` flag set.
//
// `depositPercent` (0–100) is the deposit's share. The balance is the remainder.
// Tax is split proportionally — we don't try to charge full tax on each invoice
// or the operator would over-collect on the deposit.
//
// Due dates: deposit defaults to today + org.preferences.depositDueDays.
// Balance defaults to deal.travelDates.start - org.preferences.balanceDaysBeforeTravel,
// clamped to today + 30 days when travel is unset or the math lands in the past.
export async function buildDepositBalancePayloadsFromDeal({
  deal, org,
  depositPercent,
  depositDueDays: depositDueDaysOverride,
  balanceDaysBeforeTravel: balanceLeadDaysOverride,
  taxPercentOverride,
}) {
  const base = await buildInvoicePayloadFromDeal({ deal, org, taxPercentOverride });

  const pct = Math.max(0, Math.min(100, Number(depositPercent ?? org?.preferences?.depositPercent ?? 30)));
  const depositShare = pct / 100;

  // Round to 2 decimals on the deposit, give the balance whatever's left so
  // deposit + balance == total exactly (no rounding loss on either side).
  const round2 = (n) => Math.round(n * 100) / 100;
  const depositSubtotal = round2(base.subtotal * depositShare);
  const balanceSubtotal = round2(base.subtotal - depositSubtotal);
  const depositTax = round2(base.taxAmount * depositShare);
  const balanceTax = round2(base.taxAmount - depositTax);

  const today = new Date();
  // Per-call overrides win; otherwise fall back to org preferences; otherwise
  // hardcoded defaults. `?? null` — not `||` — because 0 is a meaningful value
  // (operator might want "deposit due today").
  const depositDueDays = Math.max(0, Number(
    depositDueDaysOverride ?? org?.preferences?.depositDueDays ?? 7
  ));
  const balanceLeadDays = Math.max(0, Number(
    balanceLeadDaysOverride ?? org?.preferences?.balanceDaysBeforeTravel ?? 60
  ));

  const depositDue = new Date(today);
  depositDue.setDate(depositDue.getDate() + depositDueDays);

  let balanceDue;
  if (deal.travelDates?.start) {
    balanceDue = new Date(deal.travelDates.start);
    balanceDue.setDate(balanceDue.getDate() - balanceLeadDays);
    // If travel is too close (or already past), don't generate a date in the
    // past — that misleads the client into thinking the invoice is overdue
    // the moment they receive it.
    const minBalanceDate = new Date(today);
    minBalanceDate.setDate(minBalanceDate.getDate() + 30);
    if (balanceDue < minBalanceDate) balanceDue = minBalanceDate;
  } else {
    balanceDue = new Date(today);
    balanceDue.setDate(balanceDue.getDate() + 30);
  }

  const tripLabel = deal.title ? ` — ${deal.title}` : '';

  const depositPayload = {
    ...base,
    type: 'deposit',
    issueDate: new Date(),
    dueDate: depositDue,
    lineItems: [{
      description: `Deposit (${pct}%)${tripLabel}`,
      quantity: 1,
      unitPrice: depositSubtotal,
      total: depositSubtotal,
    }],
    subtotal: depositSubtotal,
    taxAmount: depositTax,
    total: depositSubtotal + depositTax,
  };

  const balancePct = Math.round((100 - pct) * 100) / 100;
  const balancePayload = {
    ...base,
    type: 'balance',
    issueDate: new Date(),
    dueDate: balanceDue,
    lineItems: [{
      description: `Balance (${balancePct}%)${tripLabel}`,
      quantity: 1,
      unitPrice: balanceSubtotal,
      total: balanceSubtotal,
    }],
    subtotal: balanceSubtotal,
    taxAmount: balanceTax,
    total: balanceSubtotal + balanceTax,
  };

  return { deposit: depositPayload, balance: balancePayload };
}
