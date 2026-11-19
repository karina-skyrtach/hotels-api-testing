// Room types і Rooms
import { route } from '../app.js';
import { getDb } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import {
  Validator, paginated, parseIntStrict, parsePathId, readPagination, readQuery,
} from '../lib/validate.js';

export const ROOM_STATUSES = ['active', 'cleaning', 'maintenance', 'out_of_order'];

const ROOM_TYPE_SQL = `
  SELECT rt.*, (SELECT COUNT(*) FROM rooms r WHERE r.room_type_id = rt.room_type_id) AS rooms_count
  FROM room_types rt`;

const roomTypeView = (rt) => ({
  room_type_id: rt.room_type_id,
  code: rt.code,
  name: rt.name,
  max_adults: rt.max_adults,
  max_children: rt.max_children,
  bed_type: rt.bed_type,
  area_sqm: rt.area_sqm,
  view: rt.view,
  base_price: rt.base_price,
  description: rt.description,
  rooms_count: rt.rooms_count,
});

const ROOM_SQL = `
  SELECT r.*, rt.code AS rt_code, rt.name AS rt_name
  FROM rooms r JOIN room_types rt ON rt.room_type_id = r.room_type_id`;

const roomView = (r) => ({
  room_id: r.room_id,
  room_number: r.room_number,
  floor: r.floor,
  room_type: { room_type_id: r.room_type_id, code: r.rt_code, name: r.rt_name },
  is_smoking: r.is_smoking,
  is_accessible: r.is_accessible,
  status: r.status,
});

const getRoom = (id) => getDb().prepare(`${ROOM_SQL} WHERE r.room_id = ?`).get(id);

// GET /room-types — усі категорії, дешевші спочатку
route('GET', '/room-types', () => {
  const rows = getDb().prepare(`${ROOM_TYPE_SQL} ORDER BY rt.base_price, rt.room_type_id`).all();
  return { body: { data: rows.map(roomTypeView) } };
});

// GET /room-types/:id — одна категорія + зручності
route('GET', '/room-types/:id', ({ params }) => {
  const id = parsePathId(params.id);
  const db = getDb();
  const rt = db.prepare(`${ROOM_TYPE_SQL} WHERE rt.room_type_id = ?`).get(id);
  if (!rt) throw notFound('Room type');
  const amenities = db
    .prepare(
      `SELECT a.name FROM amenities a
       JOIN room_type_amenities rta ON rta.amenity_id = a.amenity_id
       WHERE rta.room_type_id = ? ORDER BY a.name`,
    )
    .all(id)
    .map((a) => a.name);
  return { body: { ...roomTypeView(rt), amenities } };
});

// GET /rooms — список номерів з фільтрами
route('GET', '/rooms', ({ query }) => {
  const db = getDb();
  const v = new Validator();
  const where = [];
  const args = [];

  const floor = readQuery(query, 'floor', v);
  if (floor !== undefined) {
    const n = parseIntStrict(floor);
    if (v.check(n !== null && n >= 2 && n <= 13, 'floor', 'must be an integer from 2 to 13')) {
      where.push('r.floor = ?');
      args.push(n);
    }
  }

  const roomType = readQuery(query, 'room_type', v);
  if (roomType !== undefined) {
    const codes = db.prepare('SELECT code FROM room_types').all().map((x) => x.code);
    if (v.check(codes.includes(roomType), 'room_type', `must be one of: ${codes.join(', ')}`)) {
      where.push('rt.code = ?');
      args.push(roomType);
    }
  }

  const status = readQuery(query, 'status', v);
  if (status !== undefined) {
    if (v.check(ROOM_STATUSES.includes(status), 'status', `must be one of: ${ROOM_STATUSES.join(', ')}`)) {
      where.push('r.status = ?');
      args.push(status);
    }
  }

  const accessible = readQuery(query, 'is_accessible', v);
  if (accessible !== undefined) {
    if (v.check(accessible === '0' || accessible === '1', 'is_accessible', 'must be 0 or 1')) {
      where.push('r.is_accessible = ?');
      args.push(Number(accessible));
    }
  }

  const pg = readPagination(query, v);
  v.throwIfErrors();

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM rooms r JOIN room_types rt ON rt.room_type_id = r.room_type_id ${whereSql}`)
    .get(...args);
  const rows = db
    .prepare(`${ROOM_SQL} ${whereSql} ORDER BY r.room_number LIMIT ? OFFSET ?`)
    .all(...args, pg.limit, pg.offset);
  return { body: paginated(rows.map(roomView), total, pg) };
});

// GET /rooms/:id
route('GET', '/rooms/:id', ({ params }) => {
  const room = getRoom(parsePathId(params.id));
  if (!room) throw notFound('Room');
  return { body: roomView(room) };
});

// PATCH /rooms/:id/status — тільки admin
route('PATCH', '/rooms/:id/status', ({ params, body }) => {
  const id = parsePathId(params.id);
  const v = new Validator();
  if (body.status === undefined || body.status === null) v.add('status', 'is required');
  else v.check(ROOM_STATUSES.includes(body.status), 'status', `must be one of: ${ROOM_STATUSES.join(', ')}`);
  v.throwIfErrors();

  const db = getDb();
  const room = getRoom(id);
  if (!room) throw notFound('Room');

  if (['maintenance', 'out_of_order'].includes(body.status)) {
    const occupied = db
      .prepare("SELECT 1 FROM bookings WHERE room_id = ? AND status = 'checked_in' LIMIT 1")
      .get(id);
    if (occupied) throw conflict('ROOM_OCCUPIED', 'A guest is currently checked in to this room');
  }

  db.prepare('UPDATE rooms SET status = ? WHERE room_id = ?').run(body.status, id);
  return { body: roomView(getRoom(id)) };
}, { admin: true, body: true });
