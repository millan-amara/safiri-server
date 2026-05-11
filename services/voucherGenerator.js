// Voucher generation logic, factored out of routes/vouchers.js so the
// auto-on-deal-won path in routes/crm.js can reuse the same machinery as the
// manual /generate-from-quote endpoint without duplicating the segment-grouping
// and dedup rules.
import Voucher from '../models/Voucher.js';
import Quote from '../models/Quote.js';

// Per-org auto-incrementing voucher number. Matches invoice numbering: never
// resets, monotonic per organization, unique-indexed at the model level so a
// concurrent insert race surfaces as a 11000 the caller can retry.
export async function nextVoucherNumber(organizationId) {
  const last = await Voucher.findOne({ organization: organizationId })
    .sort({ voucherNumber: -1 })
    .select('voucherNumber')
    .lean();
  return (last?.voucherNumber || 0) + 1;
}

// Derive a meal-plan code from a quote.day's meals booleans. All three meals
// → FB; B+L or B+D → HB; just breakfast → BB; nothing → ''. Multi-day stays
// inherit the FIRST day's plan — operator can edit per-voucher afterwards.
function mealPlanFromMeals(meals) {
  if (!meals) return '';
  const { breakfast, lunch, dinner } = meals;
  if (breakfast && lunch && dinner) return 'FB';
  if (breakfast && (lunch || dinner)) return 'HB';
  if (breakfast) return 'BB';
  return '';
}

// Add `n` days to a Date without timezone drift (avoids DST half-day rounding).
function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Walk quote.days, group consecutive nights at the same hotel into stay
// segments. A "different hotel" boundary or a day with no hotel ends a group.
// Days without hotels (transit / arrival before first lodge) are skipped.
//
// Returns: [{ hotelId, name, location, contactEmail, contactPhone,
//             roomType, mealPlan, firstDay, lastDay, nights }]
// where firstDay/lastDay are dayNumber (1-indexed). checkIn/out are computed
// later from the quote's startDate.
export function groupConsecutiveStays(days) {
  const groups = [];
  let current = null;

  // Sort defensively — days SHOULD already be in dayNumber order, but defend
  // against quotes whose days array got reordered in the UI without resorting.
  const sorted = [...(days || [])].sort((a, b) => (a.dayNumber || 0) - (b.dayNumber || 0));

  for (const day of sorted) {
    const hotel = day.hotel;
    if (!hotel?.name) {
      if (current) { groups.push(current); current = null; }
      continue;
    }

    // Match by hotelId first (more reliable when an org has two lodges with
    // the same display name), fall back to name.
    const sameAsPrev = current
      && (
        (current.hotelId && (hotel.hotelId || hotel._id) && String(current.hotelId) === String(hotel.hotelId || hotel._id))
        || (!current.hotelId && current.name === hotel.name)
      );

    if (sameAsPrev) {
      current.lastDay = day.dayNumber;
    } else {
      if (current) groups.push(current);
      current = {
        hotelId: hotel.hotelId || hotel._id || null,
        name: hotel.name,
        location: [hotel.location, hotel.destination].filter(Boolean).join(', '),
        contactEmail: hotel.contactEmail || '',
        contactPhone: hotel.contactPhone || '',
        roomType: day.roomType || '',
        mealPlan: mealPlanFromMeals(day.meals),
        firstDay: day.dayNumber,
        lastDay: day.dayNumber,
      };
    }
  }
  if (current) groups.push(current);

  return groups.map(g => ({ ...g, nights: (g.lastDay - g.firstDay) + 1 }));
}

// Preview what generate-from-quote WOULD create. Used by the modal to show
// the operator a list of stays before they commit. Also computes which
// segments would be skipped because a non-cancelled voucher already exists.
export async function previewVouchersFromQuote(quote, existingVouchers) {
  if (!quote.startDate) {
    return { error: 'Quote has no start date — set travel dates before generating vouchers.' };
  }

  const groups = groupConsecutiveStays(quote.days);
  if (groups.length === 0) {
    return { error: 'No hotels found in this quote.' };
  }

  // Dedup key: hotelName + checkInISO. Same hotel on different dates is a
  // separate stay (split visit), so dates matter.
  const existingKeys = new Set(
    (existingVouchers || [])
      .filter(v => v.status !== 'cancelled')
      .map(v => `${v.hotel?.name || ''}|${v.checkIn ? new Date(v.checkIn).toISOString().slice(0, 10) : ''}`)
  );

  const segments = groups.map(g => {
    const checkIn = addDays(quote.startDate, g.firstDay - 1);
    const checkOut = addDays(quote.startDate, g.lastDay);
    const key = `${g.name}|${checkIn.toISOString().slice(0, 10)}`;
    return {
      hotelId: g.hotelId,
      hotel: {
        name: g.name,
        location: g.location,
        contactEmail: g.contactEmail,
        contactPhone: g.contactPhone,
      },
      roomType: g.roomType,
      mealPlan: g.mealPlan,
      checkIn,
      checkOut,
      nights: g.nights,
      alreadyExists: existingKeys.has(key),
    };
  });

  return { segments };
}

// Create draft vouchers for every accommodation segment in the quote. Skips
// segments that already have a non-cancelled voucher (so re-running after
// adding a stop is safe). Returns { created, skipped, failed }.
//
// Caller is responsible for pipeline-access checks before calling this.
export async function generateVouchersFromQuote({ quote, deal, organizationId, userId }) {
  const existing = await Voucher.find({
    organization: organizationId,
    deal: deal._id,
  }).select('hotel checkIn status').lean();

  const { segments, error } = await previewVouchersFromQuote(quote, existing);
  if (error) return { error, created: [], skipped: 0, failed: [] };

  const guest = {
    name: deal.contact ? `${deal.contact.firstName || ''} ${deal.contact.lastName || ''}`.trim() : '',
    email: deal.contact?.email || '',
    phone: deal.contact?.phone || '',
  };
  const adults = quote.travelers?.adults || deal.groupSize || 1;
  const children = quote.travelers?.children || 0;

  const created = [];
  const failed = [];
  let skipped = 0;
  for (const seg of segments) {
    if (seg.alreadyExists) { skipped++; continue; }
    try {
      const voucher = await Voucher.create({
        organization: organizationId,
        deal: deal._id,
        contact: deal.contact?._id || null,
        quote: quote._id,
        createdBy: userId,
        voucherNumber: await nextVoucherNumber(organizationId),
        hotelRef: seg.hotelId || null,
        hotel: seg.hotel,
        guest,
        adults,
        children,
        checkIn: seg.checkIn,
        checkOut: seg.checkOut,
        roomType: seg.roomType,
        rooms: 1,
        mealPlan: seg.mealPlan,
      });
      created.push(voucher);
    } catch (err) {
      // Most likely cause is the unique-index race on voucherNumber, recoverable
      // on a manual retry. Keep going so partial success still ships.
      console.error('[voucher-generator] segment failed:', err.message);
      failed.push({ hotel: seg.hotel?.name || 'unknown', message: err.message });
    }
  }

  return { created, skipped, failed, total: segments.length };
}

// Auto-generate voucher drafts on deal-won. Runs only when the org has the
// preference enabled. Quote selection is conservative: requires exactly one
// LIVE quote on the deal — if multiple, the operator must pick manually,
// because picking the wrong one could send the lodge a stale itinerary.
//
// Outcome shapes (used by the caller to render the right notification):
//   { reason: 'no_quote' }                — no live quotes on the deal
//   { reason: 'multiple_quotes', count }  — ambiguous; operator picks manually
//   { reason: 'no_hotels', quoteNumber }  — quote exists but has no accommodation
//   { reason: 'created', quoteNumber, created, skipped, failed, total }
export async function autoGenerateVouchersOnDealWon({ deal, organizationId, userId }) {
  // "Live" = status that represents a real, non-rejected proposal. Drafts and
  // rejected/expired quotes don't count — those aren't what the client agreed to.
  const LIVE_STATUSES = ['sent', 'viewed', 'accepted'];
  const liveQuotes = await Quote.find({
    organization: organizationId,
    deal: deal._id,
    status: { $in: LIVE_STATUSES },
  }).sort({ updatedAt: -1 }).lean();

  if (liveQuotes.length === 0) {
    return { reason: 'no_quote' };
  }
  if (liveQuotes.length > 1) {
    return { reason: 'multiple_quotes', count: liveQuotes.length };
  }

  const quote = liveQuotes[0];
  const result = await generateVouchersFromQuote({ quote, deal, organizationId, userId });

  if (result.error || (result.total === 0 && result.skipped === 0)) {
    return { reason: 'no_hotels', quoteNumber: quote.quoteNumber };
  }

  return {
    reason: 'created',
    quoteNumber: quote.quoteNumber,
    created: result.created,
    skipped: result.skipped,
    failed: result.failed,
    total: result.total,
  };
}
