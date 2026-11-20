// Бізнес-логіка готелю, яку використовують кілька маршрутів:
// розрахунок ціни, промокоди, перевірка вільного номера, картка бронювання.
import { getDb } from '../db.js';
import { ApiError } from './errors.js';
import { addDays, daysBetween, isValidDate, nightsOf, today } from './dates.js';

// Округлення до копійок (математичне)
export const roundMoney = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// Бронювання з цими статусами не займають номер
export const INACTIVE_STATUSES = ['cancelled', 'no_show'];

// ---------- Ціна ----------
export function seasonMultiplier(date) {
  const row = getDb()
    .prepare('SELECT multiplier FROM seasons WHERE ? BETWEEN start_date AND end_date ORDER BY season_id LIMIT 1')
    .get(date);
  return row ? row.multiplier : 1.0;
}

// room_total = round( Σ по ночах base_price × сезон × тариф × (1 − знижка/100), 2 )
export function calcRoomTotal({ basePrice, checkIn, checkOut, priceModifier, discountPercent = 0 }) {
  let sum = 0;
  const breakdown = nightsOf(checkIn, checkOut).map((date) => {
    const season = seasonMultiplier(date);
    sum += basePrice * season * priceModifier * (1 - discountPercent / 100);
    return { date, season_multiplier: season, price: roundMoney(basePrice * season) };
  });
  return { nights_breakdown: breakdown, room_total: roundMoney(sum) };
}

// ---------- Промокоди ----------
export function findPromo(code) {
  return getDb().prepare('SELECT * FROM promo_codes WHERE upper(code) = upper(?)').get(code);
}

// Чому промокод зараз не діє (або null, якщо діє). Порядок причин — як у специфікації.
// max_uses у базі навмисно не перевіряється: ліміту використань немає.
export function promoInvalidReason(promo) {
  const now = today();
  if (promo.is_active !== 1) return 'INACTIVE';
  if (now < promo.valid_from) return 'NOT_STARTED';
  if (now > promo.valid_to) return 'EXPIRED';
  return null;
}

// Для availability і bookings: промокод має існувати (404) і діяти (400)
export function requireValidPromo(code) {
  const promo = findPromo(code);
  if (!promo) throw new ApiError(404, 'PROMO_NOT_FOUND', `Promo code ${code} not found`);
  const reason = promoInvalidReason(promo);
  if (reason) {
    throw new ApiError(400, 'PROMO_INVALID', `Promo code ${promo.code} is not valid now`, [
      { field: 'promo_code', message: reason },
    ]);
  }
  return promo;
}

// ---------- Номери ----------
// Чи вільний номер на дати. Перетин: існуюче.check_in < нове.check_out І нове.check_in < існуюче.check_out
export function isRoomFree(roomId, checkIn, checkOut) {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM bookings
       WHERE room_id = ? AND status NOT IN ('cancelled', 'no_show')
         AND check_in < ? AND ? < check_out
       LIMIT 1`,
    )
    .get(roomId, checkOut, checkIn);
  return !row;
}

// ---------- Оплати ----------
// paid_total = сума платежів paid і refunded (повернення мають від'ємну суму).
// refunded — лише старі записи в базі: API нових повернень не створює.
export function paymentSummary(booking) {
  const { paid } = getDb()
    .prepare("SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE booking_id = ? AND status IN ('paid', 'refunded')")
    .get(booking.booking_id);
  const paidTotal = roundMoney(paid);
  const balance = booking.status === 'cancelled' ? 0 : Math.max(0, roundMoney(booking.total_price - paidTotal));
  return { total_price: booking.total_price, paid_total: paidTotal, balance_due: balance };
}

// ---------- Бронювання ----------
export function getBookingByCode(code) {
  return getDb().prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);
}

// Повна картка бронювання (як у GET /bookings/:code)
export function bookingCard(bookingId) {
  const db = getDb();
  const b = db
    .prepare(
      `SELECT b.*, g.first_name, g.last_name, r.room_number, rt.code AS room_type_code,
              rp.code AS rate_plan_code, p.code AS promo_code, p.discount_percent
       FROM bookings b
       JOIN guests g ON g.guest_id = b.guest_id
       JOIN rooms r ON r.room_id = b.room_id
       JOIN room_types rt ON rt.room_type_id = r.room_type_id
       JOIN rate_plans rp ON rp.rate_plan_id = b.rate_plan_id
       LEFT JOIN promo_codes p ON p.promo_id = b.promo_id
       WHERE b.booking_id = ?`,
    )
    .get(bookingId);
  const summary = paymentSummary(b);
  return {
    booking_code: b.booking_code,
    status: b.status,
    source: b.source,
    guest: { guest_id: b.guest_id, first_name: b.first_name, last_name: b.last_name },
    room: { room_id: b.room_id, room_number: b.room_number, room_type_code: b.room_type_code },
    rate_plan: { rate_plan_id: b.rate_plan_id, code: b.rate_plan_code },
    promo: b.promo_id ? { code: b.promo_code, discount_percent: b.discount_percent } : null,
    check_in: b.check_in,
    check_out: b.check_out,
    nights: daysBetween(b.check_in, b.check_out),
    adults: b.adults,
    children: b.children,
    special_requests: b.special_requests,
    room_total: b.room_total,
    services_total: b.services_total,
    total_price: b.total_price,
    paid_total: summary.paid_total,
    balance_due: summary.balance_due,
    created_at: b.created_at,
    cancelled_at: b.cancelled_at,
  };
}

// ---------- Дати проживання (спільні правила для availability і bookings) ----------
// check_in: від сьогодні до +365 днів; check_out: пізніше за check_in, не більше 30 ночей
export function validateStay(v, checkIn, checkOut) {
  const now = today();
  if (checkIn === undefined || checkIn === null) v.add('check_in', 'is required');
  else if (!isValidDate(checkIn)) v.add('check_in', 'must be a valid date in format YYYY-MM-DD');
  else if (checkIn < now) v.add('check_in', 'must not be in the past');
  else if (checkIn > addDays(now, 365)) v.add('check_in', 'must not be more than 365 days from today');

  if (checkOut === undefined || checkOut === null) v.add('check_out', 'is required');
  else if (!isValidDate(checkOut)) v.add('check_out', 'must be a valid date in format YYYY-MM-DD');
  else if (isValidDate(checkIn)) {
    if (checkOut <= checkIn) v.add('check_out', 'must be later than check_in');
    else if (daysBetween(checkIn, checkOut) > 30) v.add('check_out', 'stay must not be longer than 30 nights');
  }
}
