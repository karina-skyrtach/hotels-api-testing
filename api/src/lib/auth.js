// Паролі та токени (JWT) на вбудованому модулі node:crypto — без сторонніх бібліотек.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
export const TOKEN_TTL_SECONDS = 3600; // токен живе 1 годину

// ---------- Паролі ----------
// У базі зберігаємо не пароль, а його «відбиток»: scrypt$<сіль>$<хеш>
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [, salt, hash] = stored.split('$');
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- JWT ----------
// Токен = заголовок.дані.підпис (кожна частина в base64url)
const b64url = (input) => Buffer.from(input).toString('base64url');
const sign = (data) => createHmac('sha256', SECRET).update(data).digest('base64url');

export function signToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: user.staff_id,
      username: user.username,
      role: user.role,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    }),
  );
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

// Повертає дані з токена або null, якщо токен підроблений чи протух
export function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expected = Buffer.from(sign(`${header}.${payload}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString());
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (h.alg !== 'HS256') return null;
    if (typeof data.exp !== 'number' || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}
