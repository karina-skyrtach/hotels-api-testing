// Auth: POST /auth/login
import { route } from '../app.js';
import { getDb } from '../db.js';
import { ApiError } from '../lib/errors.js';
import { signToken, verifyPassword, TOKEN_TTL_SECONDS } from '../lib/auth.js';
import { Validator } from '../lib/validate.js';

route('POST', '/auth/login', ({ body }) => {
  const v = new Validator();
  for (const field of ['username', 'password']) {
    const value = body[field];
    if (value === undefined || value === null) v.add(field, 'is required');
    else if (typeof value !== 'string') v.add(field, 'must be a string');
    else if (value.trim() === '') v.add(field, 'must not be empty');
  }
  v.throwIfErrors();

  // Логін чутливий до регістру: в SQLite '=' порівнює рядки точно
  const user = getDb().prepare('SELECT * FROM staff_users WHERE username = ?').get(body.username);
  if (!user || !verifyPassword(body.password, user.password_hash)) {
    // Однакове повідомлення, щоб не підказувати, який логін існує
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  }
  if (user.is_active !== 1) {
    throw new ApiError(403, 'ACCOUNT_DISABLED', 'Account is disabled');
  }

  return {
    body: {
      token: signToken(user),
      expires_in: TOKEN_TTL_SECONDS,
      user: { id: user.staff_id, username: user.username, role: user.role },
    },
  };
}, { public: true, body: true });
