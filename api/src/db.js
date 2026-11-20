// Підключення до бази.
// hotel.db        — оригінальна база (еталон). Сервер її НІКОЛИ не змінює.
// hotel.local.db  — робоча копія, з якою працює API. Її можна зіпсувати тестами
//                   і повернути в початковий стан командою `npm run db:reset`.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from './lib/auth.js';

const API_DIR = join(import.meta.dirname, '..');
export const SEED_DB = join(API_DIR, 'hotel.db');
export const LOCAL_DB = join(API_DIR, 'hotel.local.db');

// Тестові акаунти персоналу
const STAFF = [
  { username: 'admin', password: 'Admin123!', role: 'admin', is_active: 1 },
  { username: 'reception', password: 'Reception123!', role: 'receptionist', is_active: 1 },
  { username: 'disabled', password: 'Disabled123!', role: 'receptionist', is_active: 0 },
];

// Повертає базу в початковий стан: копіює еталон і додає службові таблиці
export function resetDatabase() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(LOCAL_DB + suffix, { force: true });
  }
  copyFileSync(SEED_DB, LOCAL_DB);

  const db = new DatabaseSync(LOCAL_DB);
  db.exec(`
    CREATE TABLE staff_users (
      staff_id      INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL,              -- admin / receptionist
      is_active     INTEGER NOT NULL DEFAULT 1
    );
  `);
  const insert = db.prepare(
    'INSERT INTO staff_users (username, password_hash, role, is_active) VALUES (?, ?, ?, ?)',
  );
  for (const u of STAFF) insert.run(u.username, hashPassword(u.password), u.role, u.is_active);
  db.close();
}

let db;

export function getDb() {
  if (db) return db;
  if (!existsSync(LOCAL_DB)) {
    console.log('Робочої бази ще немає — створюю hotel.local.db з hotel.db...');
    resetDatabase();
  }
  db = new DatabaseSync(LOCAL_DB);
  db.exec('PRAGMA foreign_keys = ON');
  // lower() у SQLite не вміє кирилицю, тому додаємо свою функцію
  db.function('ulower', { deterministic: true }, (s) =>
    s == null ? null : String(s).toLocaleLowerCase('uk'),
  );
  return db;
}

// Виконує кілька запитів як одне ціле: або всі, або жоден
export function transaction(fn) {
  const conn = getDb();
  conn.exec('BEGIN');
  try {
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}
