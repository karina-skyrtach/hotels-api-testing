// Серце API: приймає запит, знаходить потрібний маршрут, робить спільні перевірки
// (маршрут → токен → роль → Content-Type → JSON) і викликає обробник.
// Порядок перевірок відповідає специфікації: 404/405 → 401 → 403 → 415 → 400 → ...
import { ApiError, validationError } from './lib/errors.js';
import { verifyToken } from './lib/auth.js';
import { isPlainObject } from './lib/validate.js';

const BASE = '/api/v1';
const MAX_BODY_BYTES = 1024 * 1024; // 1 МБ

const routes = [];

// Реєстрація маршруту.
// options.public — без токена; options.admin — тільки admin; options.body — чекаємо JSON-тіло
export function route(method, path, handler, options = {}) {
  const segments = path.split('/').filter(Boolean);
  routes.push({ method, path, segments, handler, options });
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function matchSegments(routeSegments, urlSegments) {
  if (routeSegments.length !== urlSegments.length) return null;
  const params = {};
  for (let i = 0; i < routeSegments.length; i++) {
    const r = routeSegments[i];
    if (r.startsWith(':')) params[r.slice(1)] = safeDecode(urlSegments[i]);
    else if (r !== urlSegments[i]) return null;
  }
  return params;
}

function findRoute(method, pathname) {
  const urlSegments = pathname.split('/').filter(Boolean);
  if (pathname.endsWith('/') && pathname !== '/') return { notFound: true };
  const candidates = [];
  for (const r of routes) {
    const params = matchSegments(r.segments, urlSegments);
    if (params) candidates.push({ route: r, params });
  }
  if (!candidates.length) return { notFound: true };
  // Якщо шлях підходить під кілька маршрутів, точний збіг (без :параметрів) має пріоритет
  const exact = candidates.filter((c) => !c.route.segments.some((s) => s.startsWith(':')));
  const pool = exact.length ? exact : candidates;
  const found = pool.find((c) => c.route.method === method);
  if (found) return found;
  const allowed = [...new Set(pool.map((c) => c.route.method))];
  return { methodNotAllowed: true, allowed };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is larger than 1 MB'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

async function handle(req) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  // Службова сторінка, щоб перевірити в браузері, що сервер живий
  if (pathname === '/' && req.method === 'GET') {
    return { status: 200, body: { name: 'Hotels API', version: 'v1', base_url: BASE, status: 'ok' } };
  }

  if (!pathname.startsWith(`${BASE}/`)) {
    throw new ApiError(404, 'ROUTE_NOT_FOUND', `Route ${req.method} ${pathname} not found`);
  }
  const apiPath = pathname.slice(BASE.length);

  // 1. Маршрут і метод → 404 / 405
  const found = findRoute(req.method, apiPath);
  if (found.notFound) {
    throw new ApiError(404, 'ROUTE_NOT_FOUND', `Route ${req.method} ${pathname} not found`);
  }
  if (found.methodNotAllowed) {
    const err = new ApiError(405, 'METHOD_NOT_ALLOWED', `Method ${req.method} is not allowed for ${pathname}`);
    err.headers = { Allow: found.allowed.join(', ') };
    throw err;
  }
  const { route: r, params } = found;

  // 2. Токен → 401
  let user = null;
  if (!r.options.public) {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    user = match ? verifyToken(match[1]) : null;
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Missing, invalid or expired token');
  }

  // 3. Роль → 403
  if (r.options.admin && user.role !== 'admin') {
    throw new ApiError(403, 'FORBIDDEN', 'Only admin can perform this action');
  }

  // 4. Тіло запиту → 415 / 400
  let body;
  if (r.options.body) {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
    }
    const raw = await readBody(req);
    if (!raw.trim()) throw validationError([{ field: 'body', message: 'request body is required' }]);
    try {
      body = JSON.parse(raw);
    } catch {
      throw validationError([{ field: 'body', message: 'invalid JSON' }]);
    }
    if (!isPlainObject(body)) {
      throw validationError([{ field: 'body', message: 'must be a JSON object' }]);
    }
  }

  // 5. Обробник маршруту
  const result = await r.handler({ params, query: url.searchParams, body, user, headers: req.headers });
  return result;
}

export async function requestListener(req, res) {
  const started = Date.now();
  let status;
  try {
    const result = await handle(req);
    status = result.status ?? 200;
    send(res, status, result.body, result.headers);
  } catch (err) {
    if (err instanceof ApiError) {
      status = err.status;
      send(res, status, { error: err.error, message: err.message, details: err.details }, err.headers);
    } else {
      // Непередбачена помилка: деталі пишемо в консоль, а назовні — загальне повідомлення
      console.error(err);
      status = 500;
      send(res, 500, { error: 'INTERNAL_ERROR', message: 'Internal server error', details: [] });
    }
  }
  console.log(`${req.method} ${req.url} → ${status} (${Date.now() - started} ms)`);
}
