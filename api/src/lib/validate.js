// Маленькі помічники для перевірки вхідних даних.
// Validator збирає ВСІ помилки, а потім кидає одну відповідь 400 зі списком details.
import { validationError } from './errors.js';
import { isValidDate } from './dates.js';

export class Validator {
  constructor() {
    this.details = [];
  }

  add(field, message) {
    if (!this.details.some((d) => d.field === field)) this.details.push({ field, message });
  }

  has(field) {
    return this.details.some((d) => d.field === field);
  }

  // Повертає true, якщо умова виконана; інакше записує помилку
  check(condition, field, message) {
    if (!condition) this.add(field, message);
    return condition;
  }

  throwIfErrors() {
    if (this.details.length) throw validationError(this.details);
  }
}

export const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const isInt = (x) => Number.isInteger(x);
export const isPositiveInt = (x) => Number.isInteger(x) && x > 0;

// Ціле число з рядка (для query і path): '12' → 12; '1.5', 'abc', '' → null
export function parseIntStrict(str) {
  if (typeof str !== 'string' || !/^-?\d+$/.test(str)) return null;
  const n = Number(str);
  return Number.isSafeInteger(n) ? n : null;
}

// Числовий :id у шляху має бути цілим додатним числом
export function parsePathId(value, field = 'id') {
  const n = parseIntStrict(value);
  if (n === null || n < 1) {
    throw validationError([{ field, message: 'must be a positive integer' }]);
  }
  return n;
}

// Код бронювання: GCH-2026-010007
export function parseBookingCode(value) {
  if (!/^GCH-\d{4}-\d{6}$/.test(value)) {
    throw validationError([{ field: 'code', message: 'must match format GCH-YYYY-NNNNNN' }]);
  }
  return value;
}

// Читає параметр з query. Параметр, переданий двічі (?a=1&a=2), — помилка.
export function readQuery(query, name, v) {
  const all = query.getAll(name);
  if (all.length === 0) return undefined;
  if (all.length > 1) {
    v.add(name, 'must be passed only once');
    return undefined;
  }
  return all[0];
}

export function checkDateField(v, field, value) {
  return v.check(isValidDate(value), field, 'must be a valid date in format YYYY-MM-DD');
}

// Пагінація: page ≥ 1 (за замовчуванням 1), limit 1–100 (за замовчуванням 20)
export function readPagination(query, v) {
  let page = 1;
  let limit = 20;
  const rawPage = readQuery(query, 'page', v);
  const rawLimit = readQuery(query, 'limit', v);
  if (rawPage !== undefined) {
    const n = parseIntStrict(rawPage);
    if (v.check(n !== null && n >= 1, 'page', 'must be an integer >= 1')) page = n;
  }
  if (rawLimit !== undefined) {
    const n = parseIntStrict(rawLimit);
    if (v.check(n !== null && n >= 1 && n <= 100, 'limit', 'must be an integer from 1 to 100')) limit = n;
  }
  return { page, limit, offset: (page - 1) * limit };
}

export function paginated(data, total, { page, limit }) {
  return {
    data,
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}
