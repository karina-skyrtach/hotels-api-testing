// Availability, Rate plans, Promo codes
import { route } from '../app.js';
import { getDb } from '../db.js';
import { ApiError } from '../lib/errors.js';
import {
  INACTIVE_STATUSES, calcRoomTotal, findPromo, promoInvalidReason, requireValidPromo, validateStay,
} from '../lib/hotel.js';
import { daysBetween } from '../lib/dates.js';
import { Validator, parseIntStrict, readQuery } from '../lib/validate.js';

const ratePlanView = (rp) => ({
  rate_plan_id: rp.rate_plan_id,
  code: rp.code,
  name: rp.name,
  price_modifier: rp.price_modifier,
  breakfast_included: rp.breakfast_included === 1,
  is_refundable: rp.is_refundable === 1,
});

// GET /rate-plans
route('GET', '/rate-plans', () => {
  const rows = getDb().prepare('SELECT * FROM rate_plans ORDER BY rate_plan_id').all();
  return { body: { data: rows.map(ratePlanView) } };
});

// GET /promo-codes/:code/validate — чи діє промокод сьогодні
route('GET', '/promo-codes/:code/validate', ({ params }) => {
  const promo = findPromo(params.code);
  if (!promo) throw new ApiError(404, 'PROMO_NOT_FOUND', `Promo code ${params.code} not found`);
  const reason = promoInvalidReason(promo);
  if (reason) return { body: { code: promo.code, valid: false, reason } };
  return {
    body: {
      code: promo.code,
      valid: true,
      discount_percent: promo.discount_percent,
      valid_from: promo.valid_from,
      valid_to: promo.valid_to,
    },
  };
});

// GET /availability — вільні категорії і ціна. Нічого не бронює.
route('GET', '/availability', ({ query }) => {
  const db = getDb();
  const v = new Validator();

  const checkIn = readQuery(query, 'check_in', v);
  const checkOut = readQuery(query, 'check_out', v);
  if (!v.has('check_in') && !v.has('check_out')) validateStay(v, checkIn, checkOut);

  const rawAdults = readQuery(query, 'adults', v);
  let adults;
  if (!v.has('adults')) {
    if (rawAdults === undefined) v.add('adults', 'is required');
    else {
      adults = parseIntStrict(rawAdults);
      v.check(adults !== null && adults >= 1 && adults <= 4, 'adults', 'must be an integer from 1 to 4');
    }
  }

  const rawChildren = readQuery(query, 'children', v);
  let children = 0;
  if (rawChildren !== undefined) {
    children = parseIntStrict(rawChildren);
    v.check(children !== null && children >= 0 && children <= 2, 'children', 'must be an integer from 0 to 2');
  }

  const ratePlanCode = readQuery(query, 'rate_plan', v) ?? 'BAR';
  const ratePlan = db.prepare('SELECT * FROM rate_plans WHERE code = ?').get(ratePlanCode);
  if (!v.has('rate_plan') && !ratePlan) {
    const codes = db.prepare('SELECT code FROM rate_plans ORDER BY rate_plan_id').all().map((x) => x.code);
    v.add('rate_plan', `must be one of: ${codes.join(', ')}`);
  }

  const promoCode = readQuery(query, 'promo_code', v);
  if (promoCode !== undefined) v.check(promoCode.trim() !== '', 'promo_code', 'must not be empty');
  v.throwIfErrors();

  const promo = promoCode !== undefined ? requireValidPromo(promoCode) : null;
  const discount = promo ? promo.discount_percent : 0;

  const roomTypes = db
    .prepare('SELECT * FROM room_types WHERE max_adults >= ? AND max_children >= ? ORDER BY base_price')
    .all(adults, children);

  const countFree = db.prepare(
    `SELECT COUNT(*) AS free FROM rooms r
     WHERE r.room_type_id = ? AND r.status IN ('active', 'cleaning')
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
         WHERE b.room_id = r.room_id
           AND b.status NOT IN (${INACTIVE_STATUSES.map(() => '?').join(', ')})
           AND b.check_in < ? AND ? < b.check_out
       )`,
  );

  const result = [];
  for (const rt of roomTypes) {
    const { free } = countFree.get(rt.room_type_id, ...INACTIVE_STATUSES, checkOut, checkIn);
    if (free === 0) continue;
    const price = calcRoomTotal({
      basePrice: rt.base_price,
      checkIn,
      checkOut,
      priceModifier: ratePlan.price_modifier,
      discountPercent: discount,
    });
    result.push({
      room_type_id: rt.room_type_id,
      code: rt.code,
      name: rt.name,
      available_rooms: free,
      nights_breakdown: price.nights_breakdown,
      room_total: price.room_total,
    });
  }

  return {
    body: {
      check_in: checkIn,
      check_out: checkOut,
      nights: daysBetween(checkIn, checkOut),
      adults,
      children,
      rate_plan: { code: ratePlan.code, price_modifier: ratePlan.price_modifier },
      promo: promo ? { code: promo.code, discount_percent: promo.discount_percent } : null,
      room_types: result,
    },
  };
});
