// Hotel rate resolver.
//
// Given a hotel, a stay window, a party description, and a client type,
// returns the concrete price the operator would pay their partner plus a
// breakdown the UI can render and the AI can reason about.
//
// Design notes
// ─────────────
// * A rate list is chosen per stay, not per night. If the stay straddles
//   seasons (e.g. Mara trip from Dec 17 → 22 where High starts Dec 18),
//   the seasons within the chosen list handle the per-night switch; we do
//   not mix rate lists mid-stay. This mirrors how real contracts are written.
// * Pass-through fees and add-ons are surfaced but never auto-added to the
//   nightly cost. The caller decides whether they appear as separate line
//   items (park fees usually yes, drinks package usually "customer adds").
// * Child pricing sharing rule: 'sharing_with_adults' means the child
//   shares an adult's bed and pays against perPersonSharing. 'own_room'
//   means the child occupies a bed and pays against singleOccupancy. 'any'
//   means the resolver picks the more charitable (cheaper) of the two.

import { convert, getFxRate } from '../utils/fx.js';

// ─── Audience & validity ───────────────────────────────────────────────
const AUDIENCE_MATCH = {
  retail: ['retail', 'public', 'rack'],
  contract: ['contract', 'dmc', 'agent', 'sto', 'trade'],
  resident: ['resident', 'eac', 'citizen', 'local'],
};

function audienceMatches(rateListAudience = [], clientType = 'retail') {
  const accept = AUDIENCE_MATCH[clientType] || [clientType];
  return rateListAudience.some(tag => accept.includes(String(tag).toLowerCase()));
}

function validityCovers(rateList, checkIn, checkOut) {
  const from = rateList.validFrom ? new Date(rateList.validFrom) : null;
  const to = rateList.validTo ? new Date(rateList.validTo) : null;
  const lastNight = new Date(checkOut);
  lastNight.setDate(lastNight.getDate() - 1); // checkOut is morning of departure
  if (from && lastNight < from) return false;
  if (to && new Date(checkIn) > to) return false;
  return true;
}

// ─── Date helpers ──────────────────────────────────────────────────────
function eachNight(checkIn, checkOut) {
  const nights = [];
  const cur = new Date(checkIn);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(checkOut);
  end.setHours(0, 0, 0, 0);
  while (cur < end) {
    nights.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return nights;
}

function dateInRanges(date, ranges = []) {
  const d = new Date(date).getTime();
  return ranges.some(r => {
    if (!r?.from || !r?.to) return false;
    return d >= new Date(r.from).getTime() && d <= new Date(r.to).getTime();
  });
}

// Find the season that applies to a given night. A season is eligible when
// one of its dateRanges covers the date. Among eligible seasons:
//   - "Specific" matches (daysOfWeek includes this weekday OR specificDates
//     includes this exact date) win over default matches.
//   - "Default" matches are seasons with no daysOfWeek and no specificDates.
// So "Weekend" (daysOfWeek=[5,6] + specificDates=[holidays]) will beat a
// "Weekday" fallback on Saturday or on Christmas Day.
function findSeasonForNight(seasons = [], date) {
  const d = new Date(date);
  const dow = d.getDay();
  const dayMs = d.setHours(0, 0, 0, 0) && d.getTime();

  const eligible = seasons.filter(s => dateInRanges(date, s.dateRanges));
  const specific = [];
  const defaults = [];
  for (const s of eligible) {
    const hasDow = (s.daysOfWeek || []).length > 0;
    const hasDates = (s.specificDates || []).length > 0;
    if (!hasDow && !hasDates) { defaults.push(s); continue; }
    const dowMatch = hasDow && s.daysOfWeek.includes(dow);
    const dateMatch = hasDates && s.specificDates.some(x => {
      const xd = new Date(x);
      xd.setHours(0, 0, 0, 0);
      return xd.getTime() === dayMs;
    });
    if (dowMatch || dateMatch) specific.push(s);
  }
  return specific[0] || defaults[0] || null;
}

// ─── Room allocation ───────────────────────────────────────────────────
// Given adults and optional explicit room split, return a shape the pricer
// can use: [{ occupancy: 'single'|'double'|'triple'|'quad', adults, children }]
function allocateRooms({ adults = 2, childAges = [], rooms }) {
  // Explicit split takes precedence
  if (rooms && (rooms.doubles || rooms.singles || rooms.triples || rooms.quads)) {
    const slots = [];
    for (let i = 0; i < (rooms.singles || 0); i++) slots.push({ occupancy: 'single', adults: 1, children: 0 });
    for (let i = 0; i < (rooms.doubles || 0); i++) slots.push({ occupancy: 'double', adults: 2, children: 0 });
    for (let i = 0; i < (rooms.triples || 0); i++) slots.push({ occupancy: 'triple', adults: 3, children: 0 });
    for (let i = 0; i < (rooms.quads || 0); i++) slots.push({ occupancy: 'quad', adults: 4, children: 0 });
    // Distribute kids across rooms (favoring larger rooms first)
    let remainingKids = childAges.length;
    for (const s of slots.sort((a, b) => (b.adults - a.adults))) {
      if (!remainingKids) break;
      s.children++;
      remainingKids--;
    }
    return slots;
  }

  // Infer: pair adults into doubles, single leftover into a single.
  const slots = [];
  let a = adults;
  while (a >= 2) { slots.push({ occupancy: 'double', adults: 2, children: 0 }); a -= 2; }
  if (a === 1) slots.push({ occupancy: 'single', adults: 1, children: 0 });
  if (!slots.length) slots.push({ occupancy: 'double', adults: 0, children: 0 }); // all-kids stay is unusual

  // Distribute kids into rooms, preferring doubles (sharing with parents).
  let remaining = childAges.length;
  for (const s of slots) {
    if (!remaining) break;
    if (s.occupancy !== 'single') {
      const add = Math.min(remaining, 2); // max 2 kids per room, charitable default
      s.children += add;
      remaining -= add;
    }
  }
  // Overflow kids → add a child-only "own room" single
  while (remaining > 0) {
    slots.push({ occupancy: 'single', adults: 0, children: 1 });
    remaining--;
  }

  return slots;
}

// ─── Child pricing ─────────────────────────────────────────────────────
function pickBracket(brackets = [], age, inOwnRoom) {
  const candidates = brackets.filter(b => age >= (b.minAge ?? 0) && age <= (b.maxAge ?? 17));
  if (!candidates.length) return null;
  // Prefer bracket matching sharing rule if one exists
  const byRule = candidates.find(b => {
    if (b.sharingRule === 'any') return true;
    if (inOwnRoom) return b.sharingRule === 'own_room';
    return b.sharingRule === 'sharing_with_adults';
  });
  return byRule || candidates[0];
}

// Returns the per-person-equivalent of a sharing rate. In per_person mode
// perPersonSharing IS the per-person value; in per_room_total mode it's the
// double-room total and needs dividing by 2 for per-person child pricing etc.
function effectivePerPerson(roomPricing) {
  const rate = Number(roomPricing.perPersonSharing) || 0;
  if (roomPricing.pricingMode === 'per_room_total') return rate / 2;
  return rate;
}

function childCost(bracket, roomPricing, inOwnRoom) {
  if (!bracket) return { amount: 0, mode: 'missing_bracket' };
  if (bracket.mode === 'free') return { amount: 0, mode: 'free' };
  if (bracket.mode === 'flat') return { amount: Number(bracket.value) || 0, mode: 'flat' };
  // pct: apply against effective per-person rate (sharing) or singleOccupancy (own room)
  const base = inOwnRoom ? (roomPricing.singleOccupancy || 0) : effectivePerPerson(roomPricing);
  return { amount: base * (Number(bracket.value) || 0) / 100, mode: 'pct' };
}

// ─── Room pricing ──────────────────────────────────────────────────────
function priceRoomSlot(slot, roomPricing, childAges) {
  // Cost for a single night, a single room slot.
  // Base: adults × the occupancy-appropriate per-person rate
  //       OR singleOccupancy if occupancy='single'.
  // Children: resolve against child brackets.

  let base = 0;
  const breakdown = [];

  const isPerRoom = roomPricing.pricingMode === 'per_room_total';

  if (slot.occupancy === 'single') {
    if (slot.adults) {
      // Single is always a total for one person — no mode ambiguity.
      base += (roomPricing.singleOccupancy || 0) * slot.adults;
      breakdown.push({ kind: 'adult_single', count: slot.adults, perUnit: roomPricing.singleOccupancy });
    }
  } else {
    const storageKey = {
      double: 'perPersonSharing',
      triple: 'triplePerPerson',
      quad: 'quadPerPerson',
    }[slot.occupancy];
    const stored = roomPricing[storageKey] || roomPricing.perPersonSharing || 0;
    if (slot.adults) {
      if (isPerRoom) {
        // Stored value is the whole room's nightly total. One charge per room,
        // not per adult, regardless of how many adults are actually in it.
        base += stored;
        breakdown.push({ kind: `room_${slot.occupancy}`, count: 1, perUnit: stored });
      } else {
        base += stored * slot.adults;
        breakdown.push({ kind: `adult_${slot.occupancy}`, count: slot.adults, perUnit: stored });
      }
    }
    // Single supplement only makes sense in per_person mode (where a solo
    // in a double pays the double per-person rate plus a supplement).
    if (!isPerRoom && slot.adults === 1 && slot.occupancy === 'double' && roomPricing.singleSupplement) {
      base += roomPricing.singleSupplement;
      breakdown.push({ kind: 'single_supplement', count: 1, perUnit: roomPricing.singleSupplement });
    }
  }

  // Children assigned to this slot: assume they share with adults unless slot has no adults.
  const kidsInOwnRoom = slot.adults === 0;
  // We need the actual ages for the kids assigned — but allocateRooms only
  // tracks counts, not ages. Use ages from the incoming list greedily.
  // Caller must pass remaining child ages via closure or we flatten elsewhere.
  // For clarity, accept child ages as a parameter here (caller splits).
  for (const age of childAges) {
    const bracket = pickBracket(roomPricing.childBrackets, age, kidsInOwnRoom);
    const c = childCost(bracket, roomPricing, kidsInOwnRoom);
    base += c.amount;
    breakdown.push({ kind: `child_${c.mode}`, count: 1, age, perUnit: c.amount, bracketLabel: bracket?.label });
  }

  return { base, breakdown };
}

// Pick the room type to price against. If caller specifies one, use it;
// otherwise pick the cheapest perPersonSharing (operators typically lead
// with their cheapest room; luxury quotes override).
function pickRoomPricing(season, preferredRoomType) {
  if (!season?.rooms?.length) return null;
  if (preferredRoomType) {
    const match = season.rooms.find(r => r.roomType?.toLowerCase() === preferredRoomType.toLowerCase());
    if (match) return match;
  }
  return season.rooms.slice().sort((a, b) => (a.perPersonSharing || 0) - (b.perPersonSharing || 0))[0];
}

// ─── Supplements ───────────────────────────────────────────────────────
// Supplements can be denominated in a different currency than the rate list
// (Chui Lodge: KES room rates, USD Christmas/Easter supplements). We return
// both the native amount and the amount converted to the rate list's source
// currency so `base + supplements` on a single night stays in one currency.
function supplementsForNight(season, date, pax, rooms, rateListCurrency, orgFxOverrides) {
  const applicable = (season?.supplements || []).filter(s => dateInRanges(date, s.dates));
  const totalAdults = rooms.reduce((s, r) => s + r.adults, 0);
  const totalChildren = rooms.reduce((s, r) => s + r.children, 0);
  return applicable.map(s => {
    const adultAmt = (Number(s.amountPerPerson) || 0) * totalAdults;
    const childAmt = (Number(s.amountPerChild) || 0) * totalChildren;
    const roomAmt = (Number(s.amountPerRoom) || 0) * rooms.length;
    const nativeAmount = adultAmt + childAmt + roomAmt;
    const nativeCurrency = s.currency || rateListCurrency;
    const amountInSource = nativeCurrency === rateListCurrency
      ? nativeAmount
      : convert(nativeAmount, nativeCurrency, rateListCurrency, orgFxOverrides);
    return {
      name: s.name,
      nativeAmount,
      nativeCurrency,
      amount: amountInSource,       // in rate list (source) currency — safe to sum with base
      mandatory: s.mandatory !== false,
      notes: s.notes || '',
    };
  });
}

// ─── Pass-through fees ─────────────────────────────────────────────────
function resolvePassThroughFees(rateList, checkIn, checkOut, pax, nationality, nights) {
  const out = [];
  for (const fee of (rateList.passThroughFees || [])) {
    const feeCurrency = fee.currency || rateList.currency;

    // Find an applicable row (by date) in the tiered table, else use flatAmount
    const row = (fee.tieredRows || []).find(r => {
      if (!r.validFrom || !r.validTo) return true;
      return new Date(checkIn) >= new Date(r.validFrom) && new Date(checkOut) <= new Date(r.validTo);
    });

    const adultKey = nationality === 'citizen' ? 'adultCitizen'
                   : nationality === 'resident' ? 'adultResident'
                   : 'adultNonResident';
    const childKey = nationality === 'citizen' ? 'childCitizen'
                   : nationality === 'resident' ? 'childResident'
                   : 'childNonResident';

    const adultRate = row ? (row[adultKey] || 0) : (fee.flatAmount || 0);
    // Child fees usually apply only to a specific age band (e.g. Mara 9–17).
    // Children outside that band are free for fee purposes.
    const childEligible = row
      ? pax.childAges.filter(a => a >= (row.childMinAge || 0) && a <= (row.childMaxAge || 17)).length
      : pax.childAges.length;
    const childRate = row ? (row[childKey] || 0) : 0;

    // Multiply by the unit
    const totalPax = pax.adults + pax.childAges.length;
    let amount = 0;
    switch (fee.unit) {
      case 'per_person_per_day':
      case 'per_person_per_night':
        amount = (adultRate * pax.adults + childRate * childEligible) * nights;
        break;
      case 'per_person_per_entry':
        amount = adultRate * pax.adults + childRate * childEligible;
        break;
      case 'per_room_per_night':
        amount = adultRate * (pax.adults + pax.childAges.length) * nights; // approximation — adults count as rooms proxy
        break;
      case 'flat':
      default:
        amount = adultRate + childRate * childEligible;
        break;
    }

    out.push({
      name: fee.name,
      currency: feeCurrency,
      amount,
      unit: fee.unit,
      mandatory: fee.mandatory !== false,
      notes: fee.notes || '',
    });
  }
  return out;
}

// ─── Main entry points ────────────────────────────────────────────────

// Pick the best rate list for a stay. Returns { rateList, warnings } or null.
export function pickRateList(hotel, { checkIn, checkOut, clientType = 'retail', preferredMealPlan }) {
  const warnings = [];
  const lists = (hotel.rateLists || []).filter(l => l.isActive !== false);

  let eligible = lists.filter(l => audienceMatches(l.audience, clientType));
  if (!eligible.length) {
    warnings.push(`No rate lists match clientType=${clientType}. Falling back to any active list.`);
    eligible = lists;
  }

  const inWindow = eligible.filter(l => validityCovers(l, checkIn, checkOut));
  if (!inWindow.length) {
    warnings.push('No rate lists cover the stay window.');
    return { rateList: null, warnings };
  }

  let byMeal = inWindow;
  if (preferredMealPlan) {
    const matched = inWindow.filter(l => String(l.mealPlan).toUpperCase() === String(preferredMealPlan).toUpperCase());
    if (matched.length) byMeal = matched;
    else warnings.push(`No list with mealPlan=${preferredMealPlan}; using available plan instead.`);
  }

  const sorted = byMeal.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return { rateList: sorted[0], warnings };
}

// Primary entry: price a stay.
export function priceStay({
  hotel,
  checkIn,
  checkOut,
  pax = { adults: 2, childAges: [] },
  rooms,
  clientType = 'retail',
  nationality = 'nonResident',
  preferredMealPlan,
  preferredRoomType,
  quoteCurrency = 'USD',
  orgFxOverrides = {},
}) {
  const warnings = [];
  const picked = pickRateList(hotel, { checkIn, checkOut, clientType, preferredMealPlan });
  warnings.push(...picked.warnings);
  const rateList = picked.rateList;
  if (!rateList) {
    return { ok: false, warnings, reason: 'no_rate_list_available' };
  }

  const nights = eachNight(checkIn, checkOut);
  if (!nights.length) return { ok: false, warnings: [...warnings, 'Zero-night stay.'], reason: 'zero_nights' };

  const roomSlots = allocateRooms({ adults: pax.adults, childAges: pax.childAges, rooms });

  // Assign child ages to slots greedily (same order as allocate did).
  // We replicate the logic here to track per-slot ages. Not ideal but keeps
  // the model simple until the quote builder exposes explicit per-room config.
  const slotAges = roomSlots.map(() => []);
  let ageQueue = [...pax.childAges];
  roomSlots.forEach((s, i) => {
    for (let k = 0; k < s.children && ageQueue.length; k++) {
      slotAges[i].push(ageQueue.shift());
    }
  });

  // Per-night pricing
  const nightly = [];
  for (const date of nights) {
    const season = findSeasonForNight(rateList.seasons, date);
    if (!season) {
      warnings.push(`No season covers ${date.toISOString().slice(0, 10)} — this night skipped.`);
      nightly.push({ date, season: null, roomType: null, base: 0, supplements: [], total: 0 });
      continue;
    }

    const roomPricing = pickRoomPricing(season, preferredRoomType);
    if (!roomPricing) {
      warnings.push(`Season ${season.label} has no room pricing — this night skipped.`);
      nightly.push({ date, season: season.label, roomType: null, base: 0, supplements: [], total: 0 });
      continue;
    }

    let nightBase = 0;
    const breakdown = [];
    roomSlots.forEach((slot, i) => {
      const r = priceRoomSlot(slot, roomPricing, slotAges[i]);
      nightBase += r.base;
      breakdown.push({ slot: i, occupancy: slot.occupancy, ...r });
    });

    const sups = supplementsForNight(season, date, pax, roomSlots, rateList.currency, orgFxOverrides);
    const sumSups = sups.reduce((s, x) => s + x.amount, 0);

    nightly.push({
      date,
      season: season.label,
      roomType: roomPricing.roomType,
      base: nightBase,
      breakdown,
      supplements: sups,
      total: nightBase + sumSups,
    });
  }

  const subtotalSource = nightly.reduce((s, n) => s + n.total, 0);
  const fxRate = getFxRate(rateList.currency, quoteCurrency, orgFxOverrides) ?? 1;
  if (fxRate === 1 && String(rateList.currency).toUpperCase() !== String(quoteCurrency).toUpperCase()) {
    warnings.push(`FX rate ${rateList.currency}→${quoteCurrency} missing; using 1:1. Check org FX settings.`);
  }

  // Pass-through fees
  const ptFees = resolvePassThroughFees(rateList, checkIn, checkOut, pax, nationality, nights.length);
  const ptFeesConverted = ptFees.map(f => ({
    ...f,
    amountInQuoteCurrency: convert(f.amount, f.currency || rateList.currency, quoteCurrency, orgFxOverrides),
  }));

  // Add-ons — listed, not auto-added. Each can carry its own currency (e.g.
  // Chui's KES rate list with USD-denominated lunch / vehicle add-ons).
  const addOns = (rateList.addOns || []).map(a => {
    const currency = a.currency || rateList.currency;
    return {
      name: a.name,
      description: a.description || '',
      unit: a.unit,
      amount: a.amount,
      optional: a.optional !== false,
      currency,
      amountInQuoteCurrency: convert(a.amount, currency, quoteCurrency, orgFxOverrides),
    };
  });

  return {
    ok: true,
    hotel: { _id: hotel._id, name: hotel.name, destination: hotel.destination },
    rateList: {
      _id: rateList._id,
      name: rateList.name,
      audience: rateList.audience,
      currency: rateList.currency,
      mealPlan: rateList.mealPlan,
      mealPlanLabel: rateList.mealPlanLabel,
      priority: rateList.priority,
    },
    roomType: nightly.find(n => n.roomType)?.roomType || preferredRoomType || '',
    nights: nights.length,
    rooms: roomSlots,
    nightly,
    subtotalSource,
    subtotalInQuoteCurrency: subtotalSource * fxRate,
    sourceCurrency: rateList.currency,
    quoteCurrency,
    fxRate,
    passThroughFees: ptFeesConverted,
    addOns,
    cancellationTiers: rateList.cancellationTiers || [],
    depositPct: rateList.depositPct || 0,
    bookingTerms: rateList.bookingTerms || '',
    inclusions: rateList.inclusions || [],
    exclusions: rateList.exclusions || [],
    notes: rateList.notes || '',
    warnings,
  };
}

// Convenience: price a single night for catalog display (used by AI prompt builder).
// Returns a terse "from $X per person sharing" style signal.
export function summarizeCheapestRate(hotel, { clientType = 'retail', date = new Date(), quoteCurrency = 'USD', orgFxOverrides = {} } = {}) {
  const lists = (hotel.rateLists || [])
    .filter(l => l.isActive !== false && audienceMatches(l.audience, clientType))
    .filter(l => {
      if (!l.validFrom && !l.validTo) return true;
      const d = new Date(date).getTime();
      if (l.validFrom && d < new Date(l.validFrom).getTime()) return false;
      if (l.validTo && d > new Date(l.validTo).getTime()) return false;
      return true;
    })
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const list of lists) {
    const season = findSeasonForNight(list.seasons, date) || list.seasons?.[0];
    if (!season) continue;
    const cheapest = pickRoomPricing(season);
    if (!cheapest) continue;
    const perPerson = cheapest.perPersonSharing || cheapest.singleOccupancy || 0;
    if (!perPerson) continue;
    const converted = convert(perPerson, list.currency, quoteCurrency, orgFxOverrides);
    return {
      rateListName: list.name,
      mealPlan: list.mealPlan,
      roomType: cheapest.roomType,
      perPersonSharing: perPerson,
      sourceCurrency: list.currency,
      perPersonSharingInQuoteCurrency: converted,
      label: `${Math.round(converted)} ${quoteCurrency}/pp sharing (${list.mealPlan})`,
    };
  }
  return null;
}
