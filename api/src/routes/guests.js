// Guests
import { route } from '../app.js';
import { getDb } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import { addYears, isValidDate, nowDateTime, today } from '../lib/dates.js';
import {
  Validator, paginated, parsePathId, readPagination, readQuery,
} from '../lib/validate.js';

const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'country', 'date_of_birth', 'document_number'];
const OPTIONAL = ['email', 'phone', 'country', 'date_of_birth', 'document_number'];

const NAME_RE = /^[\p{Script=Latin}\p{Script=Cyrillic} '’ʼ-]+$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+\d{10,15}$/;
const DOCUMENT_RE = /^[A-Za-z0-9]{5,20}$/;

const guestView = (g) => ({
  guest_id: g.guest_id,
  first_name: g.first_name,
  last_name: g.last_name,
  email: g.email,
  phone: g.phone,
  country: g.country,
  date_of_birth: g.date_of_birth,
  document_number: g.document_number,
  loyalty_level: g.loyalty_level,
  created_at: g.created_at,
});

const getGuest = (id) => getDb().prepare('SELECT * FROM guests WHERE guest_id = ?').get(id);

// Перевіряє ті поля, які є в тілі, і повертає «чисті» значення (обрізані пробіли, email малими літерами).
// null для необов'язкового поля означає «очистити».
function validateGuestFields(v, body) {
  const clean = {};

  for (const field of ['first_name', 'last_name']) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null) { v.add(field, 'must not be null'); continue; }
    if (typeof value !== 'string') { v.add(field, 'must be a string'); continue; }
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > 50) { v.add(field, 'must be 1-50 characters long'); continue; }
    if (!NAME_RE.test(trimmed) || !/\p{L}/u.test(trimmed)) {
      v.add(field, 'may contain only letters (Latin, Cyrillic), spaces, hyphens and apostrophes');
      continue;
    }
    clean[field] = trimmed;
  }

  const optionalString = (field, check, message) => {
    if (!(field in body)) return;
    const value = body[field];
    if (value === null) { clean[field] = null; return; }
    if (typeof value !== 'string') { v.add(field, 'must be a string'); return; }
    if (!check(value)) { v.add(field, message); return; }
    clean[field] = value;
  };

  optionalString('email', (s) => s.length <= 100 && EMAIL_RE.test(s),
    'must be a valid email (name@domain.tld), up to 100 characters, without spaces');
  if (typeof clean.email === 'string') clean.email = clean.email.toLowerCase();

  optionalString('phone', (s) => PHONE_RE.test(s), "must be '+' followed by 10-15 digits, e.g. +380671234567");
  optionalString('country', (s) => s.length <= 56, 'must be up to 56 characters');

  optionalString('date_of_birth', (s) => {
    if (!isValidDate(s)) return false;
    return s >= '1900-01-01' && s <= addYears(today(), -18);
  }, 'must be a valid past date (YYYY-MM-DD) not earlier than 1900-01-01; guest must be at least 18');

  optionalString('document_number', (s) => DOCUMENT_RE.test(s), 'must be 5-20 Latin letters or digits');

  return clean;
}

// GET /guests
route('GET', '/guests', ({ query }) => {
  const db = getDb();
  const v = new Validator();
  const where = [];
  const args = [];

  const email = readQuery(query, 'email', v);
  if (email !== undefined && v.check(email.trim() !== '', 'email', 'must not be empty')) {
    where.push('ulower(email) = ulower(?)');
    args.push(email);
  }

  const lastName = readQuery(query, 'last_name', v);
  if (lastName !== undefined && v.check([...lastName.trim()].length >= 2, 'last_name', 'must be at least 2 characters')) {
    // Шукаємо за початком прізвища без LIKE, тому % і _ не є спецсимволами
    where.push('ulower(substr(last_name, 1, ?)) = ulower(?)');
    args.push([...lastName].length, lastName);
  }

  const pg = readPagination(query, v);
  v.throwIfErrors();

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM guests ${whereSql}`).get(...args);
  const rows = db
    .prepare(`SELECT * FROM guests ${whereSql} ORDER BY last_name, first_name, guest_id LIMIT ? OFFSET ?`)
    .all(...args, pg.limit, pg.offset);
  return { body: paginated(rows.map(guestView), total, pg) };
});

// GET /guests/:id
route('GET', '/guests/:id', ({ params }) => {
  const id = parsePathId(params.id);
  const guest = getGuest(id);
  if (!guest) throw notFound('Guest');
  const { count } = getDb().prepare('SELECT COUNT(*) AS count FROM bookings WHERE guest_id = ?').get(id);
  return { body: { ...guestView(guest), bookings_count: count } };
});

// POST /guests
route('POST', '/guests', ({ body }) => {
  const v = new Validator();
  for (const field of ['first_name', 'last_name']) {
    if (body[field] === undefined) v.add(field, 'is required');
  }
  const clean = validateGuestFields(v, body);
  if (!v.has('email') && !v.has('phone') && !clean.email && !clean.phone) {
    v.add('email', 'email or phone is required');
    v.add('phone', 'email or phone is required');
  }
  v.throwIfErrors();

  const g = { ...Object.fromEntries(OPTIONAL.map((f) => [f, null])), ...clean };
  const result = getDb()
    .prepare(
      `INSERT INTO guests (first_name, last_name, email, phone, country, date_of_birth, document_number, loyalty_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'None', ?)`,
    )
    .run(g.first_name, g.last_name, g.email, g.phone, g.country, g.date_of_birth, g.document_number, nowDateTime());
  return { status: 201, body: guestView(getGuest(Number(result.lastInsertRowid))) };
}, { body: true });

// PATCH /guests/:id — часткове оновлення
route('PATCH', '/guests/:id', ({ params, body }) => {
  const id = parsePathId(params.id);
  const v = new Validator();
  if (!FIELDS.some((f) => f in body)) {
    v.add('body', `must contain at least one of: ${FIELDS.join(', ')}`);
  }
  const clean = validateGuestFields(v, body);
  v.throwIfErrors();

  const guest = getGuest(id);
  if (!guest) throw notFound('Guest');

  const merged = { ...guest, ...clean };
  if (!merged.email && !merged.phone) {
    v.add('email', 'guest must keep at least one contact: email or phone');
    v.add('phone', 'guest must keep at least one contact: email or phone');
    v.throwIfErrors();
  }

  const fields = Object.keys(clean);
  getDb()
    .prepare(`UPDATE guests SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE guest_id = ?`)
    .run(...fields.map((f) => clean[f]), id);
  return { body: guestView(getGuest(id)) };
}, { body: true });

// DELETE /guests/:id — тільки admin
route('DELETE', '/guests/:id', ({ params }) => {
  const id = parsePathId(params.id);
  const db = getDb();
  if (!getGuest(id)) throw notFound('Guest');
  const has = db.prepare('SELECT 1 FROM bookings WHERE guest_id = ? LIMIT 1').get(id);
  if (has) throw conflict('GUEST_HAS_BOOKINGS', 'Guest has bookings and cannot be deleted');
  db.prepare('DELETE FROM guests WHERE guest_id = ?').run(id);
  return { status: 204 };
}, { admin: true });
