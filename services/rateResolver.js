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
// `position` is the child's ordinal in the slot ('first', 'second', 'third_plus')
// and lets us honor "1st child free, 2nd child 50%" rules. Brackets with
// position='any' (the default) match any ordinal — that's the legacy path
// and also serves as the fallback when no position-specific bracket fits.
function pickBracket(brackets = [], age, inOwnRoom, position = 'any') {
  const candidates = (brackets || []).filter(b => age >= (b.minAge ?? 0) && age <= (b.maxAge ?? 17));
  if (!candidates.length) return null;
  const sharingMatch = (b) => {
    if (b.sharingRule === 'any') return true;
    if (inOwnRoom) return b.sharingRule === 'own_room';
    return b.sharingRule === 'sharing_with_adults';
  };
  // Position 'first'/'second'/'third_plus' wins over 'any' when both fit.
  // Within each tier we still prefer the sharingRule match.
  const positionMatches = candidates.filter(b => (b.position || 'any') === position);
  if (positionMatches.length) {
    return positionMatches.find(sharingMatch) || positionMatches[0];
  }
  const anyPos = candidates.filter(b => (b.position || 'any') === 'any');
  if (anyPos.length) {
    return anyPos.find(sharingMatch) || anyPos[0];
  }
  // Last resort: any bracket that matched the age, even if its position was
  // for a different ordinal — better to apply something than to drop the kid.
  return candidates.find(sharingMatch) || candidates[0];
}

// Map the i-th child (sorted oldest→youngest) to a position label.
function positionFor(index) {
  if (index === 0) return 'first';
  if (index === 1) return 'second';
  return 'third_plus';
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
  if (!bracket) {
    // No bracket matched the child's age. Operators typically only define
    // brackets for the discounted ages (e.g. [0-3 free, 4-11 50%]) and treat
    // anyone older as a paying adult. Charging zero here would silently
    // under-price; charge the same rate an adult sharing the same room would.
    const base = inOwnRoom ? (roomPricing.singleOccupancy || 0) : effectivePerPerson(roomPricing);
    return { amount: base, mode: 'no_bracket_adult_rate' };
  }
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
    let stored = roomPricing[storageKey] || 0;
    // Some rate cards publish "Triple Supplement 100%" as a percentage of
    // perPersonSharing rather than an absolute number. When the explicit
    // per-person value is missing/zero AND a supplement % exists, derive
    // the per-person rate as perPersonSharing * (1 + pct/100). We only do
    // this in per_person mode — per_room_total cards always quote totals.
    if (!isPerRoom && !stored) {
      if (slot.occupancy === 'triple' && roomPricing.tripleSupplementPct) {
        stored = (roomPricing.perPersonSharing || 0) * (1 + (roomPricing.tripleSupplementPct / 100));
      } else if (slot.occupancy === 'quad' && roomPricing.quadSupplementPct) {
        stored = (roomPricing.perPersonSharing || 0) * (1 + (roomPricing.quadSupplementPct / 100));
      }
    }
    if (!stored) stored = roomPricing.perPersonSharing || 0;
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
  // Sort kids oldest→youngest so position-based brackets ("1st child", "2nd
  // child") apply to the older child first — matches what operators expect
  // when an Aldiana-style "1st free / 2nd 50%" rule shows up.
  const sortedAges = [...(childAges || [])].sort((a, b) => b - a);
  for (let i = 0; i < sortedAges.length; i++) {
    const age = sortedAges[i];
    const position = positionFor(i);
    const bracket = pickBracket(roomPricing.childBrackets, age, kidsInOwnRoom, position);
    const c = childCost(bracket, roomPricing, kidsInOwnRoom);
    base += c.amount;
    breakdown.push({ kind: `child_${c.mode}`, count: 1, age, position, perUnit: c.amount, bracketLabel: bracket?.label });
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

// Return a roomPricing with LoS-tier overrides applied. If the room has
// stayTiers and a tier matches the total stay length, its non-zero values
// replace the room-level ones. Tier values of 0 fall through, so partial
// overrides work. When no tier matches, returns the room as-is.
function applyStayTier(room, totalNights) {
  if (!room?.stayTiers?.length) return room;
  const tier = room.stayTiers.find(t => {
    const min = t.minNights ?? 1;
    const max = (t.maxNights == null) ? Infinity : t.maxNights;
    return totalNights >= min && totalNights <= max;
  });
  if (!tier) return room;
  const pick = (key) => {
    const v = tier[key];
    return (v !== undefined && v !== null && v !== 0) ? v : room[key];
  };
  return {
    ...room,
    singleOccupancy: pick('singleOccupancy'),
    perPersonSharing: pick('perPersonSharing'),
    triplePerPerson: pick('triplePerPerson'),
    quadPerPerson: pick('quadPerPerson'),
    singleSupplement: pick('singleSupplement'),
  };
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
// nightDates is the actual array of night dates from eachNight(). We walk
// each night and pick the tiered row whose validity covers THAT night,
// so a stay straddling a fee transition (e.g. Mara/Amboseli park fee that
// jumps on Jul 1) gets the correct $/night for each portion of the stay.
// The old behaviour picked one row for the whole stay and silently dropped
// fees when the stay straddled a boundary.
function resolvePassThroughFees(rateList, checkIn, checkOut, pax, nationality, nightDates, roomCount = 1) {
  const nights = Array.isArray(nightDates) ? nightDates : [];
  const out = [];

  const adultKey = nationality === 'citizen' ? 'adultCitizen'
                 : nationality === 'resident' ? 'adultResident'
                 : 'adultNonResident';
  const childKey = nationality === 'citizen' ? 'childCitizen'
                 : nationality === 'resident' ? 'childResident'
                 : 'childNonResident';

  // Defensive — allocateRooms always returns ≥1 slot for a non-empty party,
  // but a caller passing 0 here would zero out per-room fees silently.
  const rooms = Math.max(1, Number(roomCount) || 1);

  for (const fee of (rateList.passThroughFees || [])) {
    const feeCurrency = fee.currency || rateList.currency;
    const tiered = fee.tieredRows || [];

    // Find the row covering a given night. A row without dates applies to
    // every night (open row). First match wins if ranges overlap.
    const rowForNight = (d) => tiered.find(r => {
      if (!r.validFrom || !r.validTo) return true;
      const t = new Date(d).getTime();
      return t >= new Date(r.validFrom).getTime() && t <= new Date(r.validTo).getTime();
    });

    // Per-night contribution in the fee's published units.
    const nightAmount = (row) => {
      const adultRate = row ? (row[adultKey] || 0) : (fee.flatAmount || 0);
      const childRate = row ? (row[childKey] || 0) : 0;
      const childEligible = row
        ? pax.childAges.filter(a => a >= (row.childMinAge || 0) && a <= (row.childMaxAge || 17)).length
        : pax.childAges.length;
      if (fee.unit === 'per_room_per_night') {
        // One charge per room, not per pax. Caller passes the actual room
        // count from allocateRooms; the previous "adults proxy rooms" path
        // multiplied by total pax and over-charged 4-pax-in-1-room parties.
        return adultRate * rooms;
      }
      return adultRate * pax.adults + childRate * childEligible;
    };

    let amount = 0;
    switch (fee.unit) {
      case 'per_person_per_day':
      case 'per_person_per_night':
      case 'per_room_per_night':
        // Sum per-night — each night picks its own row.
        for (const d of nights) amount += nightAmount(rowForNight(d));
        break;
      case 'per_person_per_entry': {
        // One-shot at arrival, but pick the row covering the arrival date
        // so mid-year rate changes still resolve correctly.
        const row = rowForNight(checkIn);
        const adultRate = row ? (row[adultKey] || 0) : (fee.flatAmount || 0);
        const childRate = row ? (row[childKey] || 0) : 0;
        const childEligible = row
          ? pax.childAges.filter(a => a >= (row.childMinAge || 0) && a <= (row.childMaxAge || 17)).length
          : pax.childAges.length;
        amount = adultRate * pax.adults + childRate * childEligible;
        break;
      }
      case 'flat':
      default: {
        const row = rowForNight(checkIn);
        const adultRate = row ? (row[adultKey] || 0) : (fee.flatAmount || 0);
        const childRate = row ? (row[childKey] || 0) : 0;
        const childEligible = row
          ? pax.childAges.filter(a => a >= (row.childMinAge || 0) && a <= (row.childMaxAge || 17)).length
          : pax.childAges.length;
        amount = adultRate + childRate * childEligible;
        break;
      }
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

// ─── Conditions ────────────────────────────────────────────────────────
// A condition's `when` is a structured matcher. We evaluate it against the
// booking context and return whether it applies. Empty/null fields on
// `when` are treated as wildcards. Date ranges are OR'd: any night of the
// stay falling inside any range counts as a match.
function conditionApplies(when, ctx) {
  if (!when) return true;
  const totalPax = (ctx.adults || 0) + (ctx.childAges || []).length;
  if (when.minPax != null && totalPax < when.minPax) return false;
  if (when.maxPax != null && totalPax > when.maxPax) return false;
  if (when.minNights != null && ctx.nights < when.minNights) return false;
  if (when.maxNights != null && ctx.nights > when.maxNights) return false;
  if (when.nationality && when.nationality !== ctx.nationality) return false;
  if ((when.roomTypes || []).length && !when.roomTypes.includes(ctx.roomType)) return false;
  if ((when.dateRanges || []).length) {
    const anyHit = (ctx.nightDates || []).some(d => dateInRanges(d, when.dateRanges));
    if (!anyHit) return false;
  }
  return true;
}

// Apply a condition's structured `effect` to the priced result in place.
// We only auto-apply when severity is non-blocking AND the effect targets a
// scope/field we know how to mutate safely. Anything else is left to the
// renderer to surface as a callout.
function applyConditionEffect(condition, priced, rateList) {
  const eff = condition.effect || {};
  if (!eff.field) return false;                 // text-only, nothing to apply
  if (condition.severity === 'blocking') return false; // blocking conditions never auto-apply
  const path = String(eff.field);
  // Supported targets so far:
  //   "passThroughFees[Name].flatAmount"
  //   "passThroughFees[Name].tieredRows[0].adultNonResident" (etc.)
  //   "depositPct"
  //   "addOns[Name].amount"
  if (path === 'depositPct' && eff.value != null) {
    priced.depositPct = eff.value;
    return true;
  }
  const ptMatch = path.match(/^passThroughFees\[(.+?)\]\.(.+)$/);
  if (ptMatch) {
    const [, name, sub] = ptMatch;
    const fee = (priced.passThroughFees || []).find(f => f.name === name);
    if (!fee) return false;
    if (sub === 'flatAmount' || sub === 'amount') {
      if (eff.value != null) fee.amount = eff.value;
      else if (eff.percentDelta != null) fee.amount = fee.amount * (1 + eff.percentDelta / 100);
      return true;
    }
    return false;
  }
  const addonMatch = path.match(/^addOns\[(.+?)\]\.amount$/);
  if (addonMatch) {
    const addon = (priced.addOns || []).find(a => a.name === addonMatch[1]);
    if (addon && eff.value != null) {
      addon.amount = eff.value;
      return true;
    }
  }
  return false;
}

// Walk a rate list's conditions[], decide which apply to this booking,
// auto-apply structured effects (non-blocking only), and return the matched
// list for the renderer. Each entry is annotated with `applied: true|false`
// so the UI can distinguish "we adjusted for this" from "review needed".
function evaluateConditions(rateList, priced, ctx) {
  const matched = [];
  for (const c of (rateList.conditions || [])) {
    if (!conditionApplies(c.when, ctx)) continue;
    const applied = applyConditionEffect(c, priced, rateList);
    matched.push({
      _id: c._id,
      scope: c.scope,
      attachTo: c.attachTo,
      text: c.text,
      severity: c.severity,
      source: c.source,
      acknowledged: !!c.acknowledged,
      applied,
    });
  }
  return matched;
}

// ─── Main entry points ────────────────────────────────────────────────

// Pick the best rate list for a stay. Returns { rateList, warnings, reason }.
// `reason` is set on failure so callers can distinguish "hotel has no rate
// lists at all" from "lists exist but none cover this stay window" — the two
// cases need different fixes (configure rates vs. roll forward validity).
export function pickRateList(hotel, { checkIn, checkOut, clientType = 'retail', preferredMealPlan }) {
  const warnings = [];
  const lists = (hotel.rateLists || []).filter(l => l.isActive !== false);

  if (!lists.length) {
    warnings.push('Hotel has no active rate lists.');
    return { rateList: null, warnings, reason: 'no_active_rate_lists' };
  }

  let eligible = lists.filter(l => audienceMatches(l.audience, clientType));
  if (!eligible.length) {
    warnings.push(`No rate lists match clientType=${clientType}. Falling back to any active list.`);
    eligible = lists;
  }

  const inWindow = eligible.filter(l => validityCovers(l, checkIn, checkOut));
  if (!inWindow.length) {
    const windows = lists
      .map(l => `${l.name}: ${l.validFrom ? new Date(l.validFrom).toISOString().slice(0, 10) : '∞'} → ${l.validTo ? new Date(l.validTo).toISOString().slice(0, 10) : '∞'}`)
      .join('; ');
    warnings.push(`No rate lists cover the stay window. Configured windows — ${windows}.`);
    return { rateList: null, warnings, reason: 'stay_window_not_covered' };
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
    return { ok: false, warnings, reason: picked.reason || 'no_rate_list_available' };
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

  // Mandatory add-ons that recur per night (resort fees, conservancy access,
  // mandatory tip pools). Trip-level mandatory units (per_person, per_trip)
  // can't fit a per-night roll-up cleanly — those are flagged so the operator
  // line-items them. Optional add-ons stay in the showcase only.
  const totalPaxForAddOns = (Number(pax.adults) || 0) + ((pax.childAges || []).length);
  const roomCount = roomSlots.length;
  const mandatoryNightlyBreakdown = [];
  const skippedTripLevelMandatory = [];
  for (const a of (rateList.addOns || [])) {
    if (a.optional !== false) continue; // optional → showcase only
    const addonCurrency = a.currency || rateList.currency;
    const amountInSource = addonCurrency === rateList.currency
      ? Number(a.amount) || 0
      : convert(Number(a.amount) || 0, addonCurrency, rateList.currency, orgFxOverrides);
    let perNight = 0;
    switch (a.unit) {
      case 'per_person_per_day': perNight = amountInSource * totalPaxForAddOns; break;
      case 'per_room_per_day':   perNight = amountInSource * roomCount; break;
      case 'per_day':            perNight = amountInSource; break;
      // per_person, per_trip, per_vehicle: trip-level — surface as warning
      // and let the operator line-item them. Surfacing the per-trip math
      // here would be wrong because we don't always know the full stay.
      default:
        skippedTripLevelMandatory.push({ name: a.name, unit: a.unit, amount: a.amount, currency: addonCurrency });
        continue;
    }
    if (perNight > 0) {
      mandatoryNightlyBreakdown.push({ name: a.name, unit: a.unit, amount: perNight, currency: rateList.currency });
    }
  }
  const mandatoryNightlyTotal = mandatoryNightlyBreakdown.reduce((s, x) => s + x.amount, 0);
  if (skippedTripLevelMandatory.length) {
    warnings.push(
      `Mandatory add-ons with trip-level units skipped from auto-roll-up (line-item them): ${skippedTripLevelMandatory.map(x => `${x.name} (${x.unit})`).join(', ')}.`
    );
  }

  // Per-night pricing
  const nightly = [];
  for (const date of nights) {
    const season = findSeasonForNight(rateList.seasons, date);
    if (!season) {
      warnings.push(`No season covers ${date.toISOString().slice(0, 10)} — this night skipped.`);
      nightly.push({ date, season: null, roomType: null, base: 0, supplements: [], mandatoryAddOns: 0, total: 0 });
      continue;
    }

    const baseRoomPricing = pickRoomPricing(season, preferredRoomType);
    if (!baseRoomPricing) {
      warnings.push(`Season ${season.label} has no room pricing — this night skipped.`);
      nightly.push({ date, season: season.label, roomType: null, base: 0, supplements: [], mandatoryAddOns: 0, total: 0 });
      continue;
    }
    // Apply length-of-stay tier based on the total stay length (not per-night).
    const roomPricing = applyStayTier(baseRoomPricing, nights.length);

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
      mandatoryAddOns: mandatoryNightlyTotal,
      total: nightBase + sumSups + mandatoryNightlyTotal,
    });
  }

  const subtotalSource = nightly.reduce((s, n) => s + n.total, 0);
  const fxRate = getFxRate(rateList.currency, quoteCurrency, orgFxOverrides) ?? 1;
  if (fxRate === 1 && String(rateList.currency).toUpperCase() !== String(quoteCurrency).toUpperCase()) {
    warnings.push(`FX rate ${rateList.currency}→${quoteCurrency} missing; using 1:1. Check org FX settings.`);
  }

  // Pass-through fees — pass night dates so fees straddling a rate change
  // (e.g. Jul-1 park fee jump) resolve correctly per-night. roomCount drives
  // per_room_per_night fees; allocateRooms returns the actual slots used.
  const ptFees = resolvePassThroughFees(rateList, checkIn, checkOut, pax, nationality, nights, roomCount);
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

  // Normalize cancellation tiers so every entry carries a mode + a value
  // the renderer can format. For 'nights' mode we also surface the implied
  // currency amount using the stay's average nightly rate so quotes can
  // show a number alongside the "1 night" label.
  const avgNightlySource = nights.length ? subtotalSource / nights.length : 0;
  const cancellationTiers = (rateList.cancellationTiers || []).map(t => {
    const mode = t.penaltyMode || 'pct';
    const out = {
      daysBefore: t.daysBefore,
      penaltyMode: mode,
      penaltyPct: t.penaltyPct || 0,
      penaltyNights: t.penaltyNights || 0,
      penaltyAmount: t.penaltyAmount || 0,
      notes: t.notes || '',
    };
    // Compute an effective amount in the rate list's currency so callers
    // can display "≈ $X" alongside "1 night" or "30%" without re-doing math.
    if (mode === 'nights') {
      out.effectiveAmount = avgNightlySource * (t.penaltyNights || 0);
    } else if (mode === 'pct') {
      out.effectiveAmount = subtotalSource * ((t.penaltyPct || 0) / 100);
    } else if (mode === 'flat') {
      out.effectiveAmount = t.penaltyAmount || 0;
    }
    out.effectiveAmountInQuoteCurrency = out.effectiveAmount * fxRate;
    return out;
  });

  // Build the priced result first (mutable), evaluate conditions against it,
  // then return. evaluateConditions can mutate passThroughFees / addOns /
  // depositPct in place when a condition's effect targets them.
  const priced = {
    passThroughFees: ptFeesConverted,
    addOns,
    depositPct: rateList.depositPct || 0,
  };
  const matchedConditions = evaluateConditions(rateList, priced, {
    adults: pax.adults,
    childAges: pax.childAges,
    nights: nights.length,
    nightDates: nights,
    nationality,
    roomType: nightly.find(n => n.roomType)?.roomType || preferredRoomType || '',
  });
  // Surface a hard warning per blocking condition so the operator can't miss
  // it even if the renderer's callouts get scrolled past.
  for (const c of matchedConditions) {
    if (c.severity === 'blocking' && !c.acknowledged) {
      warnings.push(`BLOCKING condition (acknowledge before sending quote): ${c.text}`);
    }
  }

  return {
    ok: true,
    // Hotel-level display fields. The client snapshots these onto the day so
    // the share page / PDF can render rich detail (stars, type, sub-location,
    // amenities, contact, coordinates) without re-fetching the partner doc.
    hotel: {
      _id: hotel._id,
      name: hotel.name,
      description: hotel.description,
      images: hotel.images,
      destination: hotel.destination,
      location: hotel.location,
      type: hotel.type,
      stars: hotel.stars,
      amenities: hotel.amenities,
      coordinates: hotel.coordinates,
      contactEmail: hotel.contactEmail,
      contactPhone: hotel.contactPhone,
      tags: hotel.tags,
    },
    rateList: {
      _id: rateList._id,
      name: rateList.name,
      audience: rateList.audience,
      currency: rateList.currency,
      mealPlan: rateList.mealPlan,
      mealPlanLabel: rateList.mealPlanLabel,
      priority: rateList.priority,
      // Surfaced so the editor / quote modal can warn the operator on
      // low-confidence extractions before the rate is used in client output.
      extractionConfidence: rateList.extractionConfidence || '',
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
    passThroughFees: priced.passThroughFees,
    addOns: priced.addOns,
    // Mandatory add-ons that recur per night are already included in each
    // night.total above and therefore in subtotalSource. Surfaced here so the
    // operator UI can attribute the cost ("includes resort fees & conservancy
    // access") without having to recompute. Trip-level mandatory units (per
    // person, per trip, per vehicle) are NOT auto-rolled — those are flagged
    // in `warnings` and remain in `addOns` for the operator to line-item.
    mandatoryAddOnsPerNight: mandatoryNightlyBreakdown,
    mandatoryAddOnsPerNightTotal: mandatoryNightlyTotal,
    cancellationTiers,
    depositPct: priced.depositPct,
    bookingTerms: rateList.bookingTerms || '',
    inclusions: rateList.inclusions || [],
    exclusions: rateList.exclusions || [],
    notes: rateList.notes || '',
    // Conditions matched against this booking, with `applied` flag and
    // severity/acknowledged so the renderer can callout / block send.
    conditions: matchedConditions,
    extractionConfidence: rateList.extractionConfidence || '',
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
