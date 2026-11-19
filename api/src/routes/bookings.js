// Bookings
import { route } from '../app.js';
import { getDb, transaction } from '../db.js';
import { ApiError, conflict, notFound, referenceNotFound } from '../lib/errors.js';
import { hoursUntilCheckIn, isValidDate, nowDateTime, today } from '../lib/dates.js';
import {
  bookingCard, calcRoomTotal, getBookingByCode, isRoomFree, paymentSummary, requireValidPromo, roundMoney, validateStay,
} from '../lib/hotel.js';
import {
  Validator, isPositiveInt, paginated, parseBookingCode, parseIntStrict, readPagination, readQuery,
} from '../lib/validate.js';

export const BOOKING_STATUSES = ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'];
export const SOURCES = ['website', 'phone', 'walk_in', 'booking_com', 'expedia'];

const invalidTransition = (status, action) =>
  conflict('INVALID_STATUS_TRANSITION', `Cannot ${action} a booking with status ${status}`);

// Знаходить бронювання за кодом з шляху: 400 (формат) або 404 (немає)
export function requireBooking(code) {
  const booking = getBookingByCode(parseBookingCode(code));
  if (!booking) throw notFound('Booking');
  return booking;
}

// GET /bookings
route('GET', '/bookings', ({ query }) => {
  const db = getDb();
  const v = new Validator();
  const where = [];
  const args = [];

  const status = readQuery(query, 'status', v);
  if (status !== undefined && v.check(BOOKING_STATUSES.includes(status), 'status', `must be one of: ${BOOKING_STATUSES.join(', ')}`)) {
    where.push('b.status = ?');
    args.push(status);
  }

  const source = readQuery(query, 'source', v);
  if (source !== undefined && v.check(SOURCES.includes(source), 'source', `must be one of: ${SOURCES.join(', ')}`)) {
    where.push('b.source = ?');
    args.push(source);
  }

  const from = readQuery(query, 'check_in_from', v);
  const to = readQuery(query, 'check_in_to', v);
  if (from !== undefined && v.check(isValidDate(from), 'check_in_from', 'must be a valid date in format YYYY-MM-DD')) {
    where.push('b.check_in >= ?');
    args.push(from);
  }
  if (to !== undefined && v.check(isValidDate(to), 'check_in_to', 'must be a valid date in format YYYY-MM-DD')) {
    where.push('b.check_in <= ?');
    args.push(to);
  }
  if (isValidDate(from) && isValidDate(to)) {
    v.check(from <= to, 'check_in_to', 'must not be earlier than check_in_from');
  }

  const guestId = readQuery(query, 'guest_id', v);
  if (guestId !== undefined) {
    const n = parseIntStrict(guestId);
    if (v.check(n !== null && n >= 1, 'guest_id', 'must be a positive integer')) {
      where.push('b.guest_id = ?');
      args.push(n);
    }
  }

  const pg = readPagination(query, v);
  v.throwIfErrors();

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM bookings b ${whereSql}`).get(...args);
  const rows = db
    .prepare(
      `SELECT b.*, g.first_name, g.last_name, r.room_number, rt.code AS room_type_code,
              CAST(julianday(b.check_out) - julianday(b.check_in) AS INTEGER) AS nights
       FROM bookings b
       JOIN guests g ON g.guest_id = b.guest_id
       JOIN rooms r ON r.room_id = b.room_id
       JOIN room_types rt ON rt.room_type_id = r.room_type_id
       ${whereSql}
       ORDER BY b.check_in DESC, b.booking_id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, pg.limit, pg.offset);

  const data = rows.map((b) => ({
    booking_code: b.booking_code,
    guest: { guest_id: b.guest_id, first_name: b.first_name, last_name: b.last_name },
    room_number: b.room_number,
    room_type_code: b.room_type_code,
    check_in: b.check_in,
    check_out: b.check_out,
    nights: b.nights,
    status: b.status,
    source: b.source,
    total_price: b.total_price,
  }));
  return { body: paginated(data, total, pg) };
});

// GET /bookings/:code
route('GET', '/bookings/:code', ({ params }) => {
  const booking = requireBooking(params.code);
  return { body: bookingCard(booking.booking_id) };
});

// POST /bookings
route('POST', '/bookings', ({ body }) => {
  const db = getDb();
  const v = new Validator();

  // 1. Формат і обов'язкові поля → 400
  for (const field of ['guest_id', 'room_id', 'rate_plan_id']) {
    if (body[field] === undefined || body[field] === null) v.add(field, 'is required');
    else v.check(isPositiveInt(body[field]), field, 'must be a positive integer');
  }
  validateStay(v, body.check_in, body.check_out);

  if (body.adults === undefined || body.adults === null) v.add('adults', 'is required');
  else v.check(Number.isInteger(body.adults) && body.adults >= 1, 'adults', 'must be an integer >= 1');

  const children = body.children ?? 0;
  v.check(Number.isInteger(children) && children >= 0, 'children', 'must be an integer >= 0');

  if (body.source === undefined || body.source === null) v.add('source', 'is required');
  else v.check(SOURCES.includes(body.source), 'source', `must be one of: ${SOURCES.join(', ')}`);

  const promoCode = body.promo_code ?? null;
  if (promoCode !== null) {
    v.check(typeof promoCode === 'string' && promoCode.trim() !== '', 'promo_code', 'must be a non-empty string');
  }

  const specialRequests = body.special_requests ?? null;
  if (specialRequests !== null) {
    if (v.check(typeof specialRequests === 'string', 'special_requests', 'must be a string')) {
      v.check(specialRequests.length <= 500, 'special_requests', 'must be up to 500 characters');
    }
  }
  v.throwIfErrors();

  // 2. Посилання на інші записи → 422
  const guest = db.prepare('SELECT guest_id FROM guests WHERE guest_id = ?').get(body.guest_id);
  const room = db
    .prepare('SELECT r.*, rt.base_price, rt.max_adults, rt.max_children FROM rooms r JOIN room_types rt ON rt.room_type_id = r.room_type_id WHERE r.room_id = ?')
    .get(body.room_id);
  const ratePlan = db.prepare('SELECT * FROM rate_plans WHERE rate_plan_id = ?').get(body.rate_plan_id);
  const missing = [];
  if (!guest) missing.push({ field: 'guest_id', message: 'guest does not exist' });
  if (!room) missing.push({ field: 'room_id', message: 'room does not exist' });
  if (!ratePlan) missing.push({ field: 'rate_plan_id', message: 'rate plan does not exist' });
  if (missing.length) throw referenceNotFound(missing);

  // 3. Правила, для яких потрібен номер → 400
  v.check(body.adults <= room.max_adults, 'adults', `must be an integer from 1 to ${room.max_adults}`);
  v.check(children <= room.max_children, 'children', `must be an integer from 0 to ${room.max_children}`);
  if (body.source === 'walk_in') {
    v.check(body.check_in === today(), 'source', 'walk_in is allowed only when check_in is today');
  }
  v.throwIfErrors();

  // 4. Промокод → 404 / 400
  const promo = promoCode !== null ? requireValidPromo(promoCode) : null;

  // 5. Стан номера → 409
  if (['maintenance', 'out_of_order'].includes(room.status)) {
    throw conflict('ROOM_NOT_BOOKABLE', `Room is in status ${room.status}`);
  }

  const { room_total: roomTotal } = calcRoomTotal({
    basePrice: room.base_price,
    checkIn: body.check_in,
    checkOut: body.check_out,
    priceModifier: ratePlan.price_modifier,
    discountPercent: promo ? promo.discount_percent : 0,
  });

  const bookingId = transaction((conn) => {
    // Перевіряємо зайнятість усередині транзакції, щоб ніхто не «вклинився» між перевіркою і записом
    if (!isRoomFree(room.room_id, body.check_in, body.check_out)) {
      throw conflict('ROOM_UNAVAILABLE', 'Room is already booked for these dates');
    }
    const createdAt = nowDateTime();
    const tempCode = `TMP-${Date.now()}-${Math.random()}`;
    const res = conn
      .prepare(
        `INSERT INTO bookings (booking_code, guest_id, room_id, rate_plan_id, promo_id, check_in, check_out,
           adults, children, status, source, room_total, services_total, total_price, special_requests, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, 0, ?, ?, ?)`,
      )
      .run(tempCode, guest.guest_id, room.room_id, ratePlan.rate_plan_id, promo ? promo.promo_id : null,
        body.check_in, body.check_out, body.adults, children, body.source, roomTotal, roomTotal, specialRequests, createdAt);
    const id = Number(res.lastInsertRowid);
    const code = `GCH-${createdAt.slice(0, 4)}-${String(id).padStart(6, '0')}`;
    conn.prepare('UPDATE bookings SET booking_code = ? WHERE booking_id = ?').run(code, id);
    return id;
  });

  return { status: 201, body: bookingCard(bookingId) };
}, { body: true });

// Штраф за скасування залежно від політики тарифу і часу до заїзду
function calcPenalty(booking) {
  const policy = getDb()
    .prepare('SELECT cp.* FROM rate_plans rp JOIN cancellation_policies cp ON cp.policy_id = rp.policy_id WHERE rp.rate_plan_id = ?')
    .get(booking.rate_plan_id);
  const hoursLeft = hoursUntilCheckIn(booking.check_in);
  if (policy.free_cancel_hours !== null && hoursLeft >= policy.free_cancel_hours) return 0;
  if (policy.penalty_percent === 0) {
    // Flexible: штраф = вартість першої ночі
    const nights = getDb().prepare('SELECT CAST(julianday(?) - julianday(?) AS INTEGER) AS n').get(booking.check_out, booking.check_in).n;
    return roundMoney(booking.room_total / nights);
  }
  return roundMoney((booking.room_total * policy.penalty_percent) / 100);
}

// POST /bookings/:code/cancel
route('POST', '/bookings/:code/cancel', ({ params }) => {
  const booking = requireBooking(params.code);
  if (!['pending', 'confirmed'].includes(booking.status)) throw invalidTransition(booking.status, 'cancel');

  const penalty = calcPenalty(booking);
  const { paid_total: paidTotal } = paymentSummary(booking);
  const refund = Math.max(0, roundMoney(paidTotal - penalty));

  transaction((conn) => {
    const now = nowDateTime();
    conn.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE booking_id = ?").run(now, booking.booking_id);
    if (refund > 0) {
      const last = conn
        .prepare("SELECT method FROM payments WHERE booking_id = ? AND status = 'paid' ORDER BY paid_at DESC, payment_id DESC LIMIT 1")
        .get(booking.booking_id);
      conn
        .prepare("INSERT INTO payments (booking_id, amount, method, status, paid_at) VALUES (?, ?, ?, 'refunded', ?)")
        .run(booking.booking_id, -refund, last ? last.method : 'card', now);
    }
  });

  return { body: { ...bookingCard(booking.booking_id), cancellation: { penalty, refund_amount: refund } } };
});

// POST /bookings/:code/check-in
route('POST', '/bookings/:code/check-in', ({ params }) => {
  const booking = requireBooking(params.code);
  if (booking.status !== 'confirmed') throw invalidTransition(booking.status, 'check in');
  const now = today();
  if (now < booking.check_in || now >= booking.check_out) {
    throw conflict('CHECK_IN_NOT_ALLOWED', `Check-in is allowed from ${booking.check_in} until the day before ${booking.check_out}`);
  }
  const room = getDb().prepare('SELECT status FROM rooms WHERE room_id = ?').get(booking.room_id);
  if (['maintenance', 'out_of_order'].includes(room.status)) {
    throw conflict('ROOM_NOT_BOOKABLE', `Room is in status ${room.status}`);
  }
  getDb().prepare("UPDATE bookings SET status = 'checked_in' WHERE booking_id = ?").run(booking.booking_id);
  return { body: bookingCard(booking.booking_id) };
});

// POST /bookings/:code/check-out
route('POST', '/bookings/:code/check-out', ({ params }) => {
  const booking = requireBooking(params.code);
  if (booking.status !== 'checked_in') throw invalidTransition(booking.status, 'check out');
  const { balance_due: balance } = paymentSummary(booking);
  if (balance > 0) throw new ApiError(409, 'BALANCE_DUE', `Booking must be fully paid first. Balance due: ${balance}`);
  getDb().prepare("UPDATE bookings SET status = 'checked_out' WHERE booking_id = ?").run(booking.booking_id);
  return { body: bookingCard(booking.booking_id) };
});
