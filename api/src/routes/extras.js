// Services, Payments, Reviews
import { route } from '../app.js';
import { getDb, transaction } from '../db.js';
import { ApiError, conflict, referenceNotFound, validationError } from '../lib/errors.js';
import { isValidDate, nowDateTime } from '../lib/dates.js';
import { paymentSummary, roundMoney } from '../lib/hotel.js';
import {
  Validator, isPositiveInt, paginated, parseIntStrict, readPagination, readQuery,
} from '../lib/validate.js';
import { requireBooking } from './bookings.js';

const SERVICE_CATEGORIES = ['food', 'transport', 'wellness', 'other'];
const ACTIVE_FOR_EXTRAS = ['pending', 'confirmed', 'checked_in'];
const BREAKFAST_SERVICE_ID = 1;
const PAYMENT_METHODS = ['card', 'cash', 'bank_transfer'];

const notActive = (status) =>
  conflict('BOOKING_NOT_ACTIVE', `Booking with status ${status} cannot be changed`);

// ================= Services =================

// GET /services
route('GET', '/services', ({ query }) => {
  const v = new Validator();
  const category = readQuery(query, 'category', v);
  if (category !== undefined) {
    v.check(SERVICE_CATEGORIES.includes(category), 'category', `must be one of: ${SERVICE_CATEGORIES.join(', ')}`);
  }
  v.throwIfErrors();
  const db = getDb();
  const rows = category
    ? db.prepare('SELECT * FROM services WHERE category = ? ORDER BY service_id').all(category)
    : db.prepare('SELECT * FROM services ORDER BY service_id').all();
  return { body: { data: rows.map((s) => ({ ...s })) } };
});

// POST /bookings/:code/services
route('POST', '/bookings/:code/services', ({ params, body }) => {
  const v = new Validator();
  if (body.service_id === undefined || body.service_id === null) v.add('service_id', 'is required');
  else v.check(isPositiveInt(body.service_id), 'service_id', 'must be a positive integer');
  if (body.quantity === undefined || body.quantity === null) v.add('quantity', 'is required');
  else v.check(Number.isInteger(body.quantity) && body.quantity >= 1 && body.quantity <= 20, 'quantity', 'must be an integer from 1 to 20');
  if (body.service_date === undefined || body.service_date === null) v.add('service_date', 'is required');
  else v.check(isValidDate(body.service_date), 'service_date', 'must be a valid date in format YYYY-MM-DD');
  v.throwIfErrors();

  const booking = requireBooking(params.code);
  const db = getDb();
  const service = db.prepare('SELECT * FROM services WHERE service_id = ?').get(body.service_id);
  if (!service) throw referenceNotFound([{ field: 'service_id', message: 'service does not exist' }]);

  // Правила, які залежать від бронювання і послуги
  v.check(body.service_date >= booking.check_in && body.service_date <= booking.check_out,
    'service_date', `must be between ${booking.check_in} and ${booking.check_out}`);
  v.throwIfErrors();

  if (!ACTIVE_FOR_EXTRAS.includes(booking.status)) throw notActive(booking.status);
  if (service.service_id === BREAKFAST_SERVICE_ID) {
    const rp = db.prepare('SELECT breakfast_included FROM rate_plans WHERE rate_plan_id = ?').get(booking.rate_plan_id);
    if (rp.breakfast_included === 1) {
      throw conflict('SERVICE_ALREADY_INCLUDED', 'Breakfast is already included in the rate plan');
    }
  }

  const lineTotal = roundMoney(body.quantity * service.price);
  const result = transaction((conn) => {
    const res = conn
      .prepare('INSERT INTO booking_services (booking_id, service_id, quantity, unit_price, service_date) VALUES (?, ?, ?, ?, ?)')
      .run(booking.booking_id, service.service_id, body.quantity, service.price, body.service_date);
    const servicesTotal = roundMoney(booking.services_total + lineTotal);
    const totalPrice = roundMoney(booking.room_total + servicesTotal);
    conn.prepare('UPDATE bookings SET services_total = ?, total_price = ? WHERE booking_id = ?')
      .run(servicesTotal, totalPrice, booking.booking_id);
    return { id: Number(res.lastInsertRowid), servicesTotal, totalPrice };
  });

  return {
    status: 201,
    body: {
      booking_service: {
        booking_service_id: result.id,
        service_id: service.service_id,
        name: service.name,
        quantity: body.quantity,
        unit_price: service.price,
        line_total: lineTotal,
        service_date: body.service_date,
      },
      services_total: result.servicesTotal,
      total_price: result.totalPrice,
    },
  };
}, { body: true });

// ================= Payments =================

const paymentView = (p) => ({
  payment_id: p.payment_id,
  amount: p.amount,
  method: p.method,
  status: p.status,
  paid_at: p.paid_at,
});

// GET /bookings/:code/payments
route('GET', '/bookings/:code/payments', ({ params }) => {
  const booking = requireBooking(params.code);
  const rows = getDb().prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY payment_id').all(booking.booking_id);
  return { body: { data: rows.map(paymentView), summary: paymentSummary(booking) } };
});

// Чи має число не більше 2 знаків після крапки
const hasMaxTwoDecimals = (x) => Math.abs(Math.round(x * 100) - x * 100) < 1e-6;

// POST /bookings/:code/payments
route('POST', '/bookings/:code/payments', ({ params, body }) => {
  const v = new Validator();
  const { amount, method } = body;
  if (amount === undefined || amount === null) v.add('amount', 'is required');
  else if (typeof amount !== 'number' || !Number.isFinite(amount)) v.add('amount', 'must be a number');
  else if (amount <= 0) v.add('amount', 'must be greater than 0');
  else v.check(hasMaxTwoDecimals(amount), 'amount', 'must have at most 2 decimal places');

  if (method === undefined || method === null) v.add('method', 'is required');
  else v.check(PAYMENT_METHODS.includes(method), 'method', `must be one of: ${PAYMENT_METHODS.join(', ')}`);

  v.throwIfErrors();

  const booking = requireBooking(params.code);
  if (['cancelled', 'checked_out', 'no_show'].includes(booking.status)) throw notActive(booking.status);

  const db = getDb();

  const { balance_due: balance } = paymentSummary(booking);
  if (balance === 0) throw conflict('NOTHING_TO_PAY', 'Booking is already fully paid');
  if (amount > balance) {
    throw validationError([{ field: 'amount', message: `must not exceed balance_due (${balance})` }]);
  }

  const res = db
    .prepare("INSERT INTO payments (booking_id, amount, method, status, paid_at) VALUES (?, ?, ?, 'paid', ?)")
    .run(booking.booking_id, amount, method, nowDateTime());
  const paymentId = Number(res.lastInsertRowid);

  const payment = db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(paymentId);
  return { status: 201, body: { payment: paymentView(payment), summary: paymentSummary(booking) } };
}, { body: true });

// ================= Reviews =================

const REVIEW_SQL = `
  SELECT rv.*, b.booking_code, g.first_name AS guest_first_name
  FROM reviews rv
  JOIN bookings b ON b.booking_id = rv.booking_id
  JOIN guests g ON g.guest_id = b.guest_id`;

const reviewView = (r) => ({
  review_id: r.review_id,
  booking_code: r.booking_code,
  guest_first_name: r.guest_first_name,
  rating: r.rating,
  title: r.title,
  comment: r.comment,
  created_at: r.created_at,
});

// GET /reviews
route('GET', '/reviews', ({ query }) => {
  const db = getDb();
  const v = new Validator();
  const rawRating = readQuery(query, 'rating', v);
  let rating;
  if (rawRating !== undefined) {
    rating = parseIntStrict(rawRating);
    v.check(rating !== null && rating >= 1 && rating <= 5, 'rating', 'must be an integer from 1 to 5');
  }
  const pg = readPagination(query, v);
  v.throwIfErrors();

  const whereSql = rating !== undefined ? 'WHERE rv.rating = ?' : '';
  const args = rating !== undefined ? [rating] : [];
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM reviews rv ${whereSql}`).get(...args);
  const rows = db
    .prepare(`${REVIEW_SQL} ${whereSql} ORDER BY rv.created_at DESC, rv.review_id DESC LIMIT ? OFFSET ?`)
    .all(...args, pg.limit, pg.offset);
  return { body: paginated(rows.map(reviewView), total, pg) };
});

// POST /bookings/:code/review
route('POST', '/bookings/:code/review', ({ params, body }) => {
  const v = new Validator();
  if (body.rating === undefined || body.rating === null) v.add('rating', 'is required');
  else v.check(Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5, 'rating', 'must be an integer from 1 to 5');

  const title = body.title ?? null;
  if (title !== null && v.check(typeof title === 'string', 'title', 'must be a string')) {
    v.check(title.length <= 100, 'title', 'must be up to 100 characters');
  }
  const comment = body.comment ?? null;
  if (comment !== null && v.check(typeof comment === 'string', 'comment', 'must be a string')) {
    v.check(comment.length <= 2000, 'comment', 'must be up to 2000 characters');
  }
  v.throwIfErrors();

  const booking = requireBooking(params.code);
  if (booking.status !== 'checked_out') {
    throw conflict('REVIEW_NOT_ALLOWED', 'Review can be added only after check-out');
  }
  const db = getDb();
  if (db.prepare('SELECT 1 FROM reviews WHERE booking_id = ?').get(booking.booking_id)) {
    throw new ApiError(409, 'REVIEW_EXISTS', 'This booking already has a review');
  }

  const res = db
    .prepare('INSERT INTO reviews (booking_id, rating, title, comment, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(booking.booking_id, body.rating, title, comment, nowDateTime());
  const review = db.prepare(`${REVIEW_SQL} WHERE rv.review_id = ?`).get(Number(res.lastInsertRowid));
  return { status: 201, body: reviewView(review) };
}, { body: true });
