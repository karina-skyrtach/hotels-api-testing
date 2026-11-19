// Робота з датами. Усе рахуємо в часовому поясі готелю: Europe/Kyiv.
const TZ = 'Europe/Kyiv';

// Поточні дата і час у Києві як рядки: '2026-11-19' і '2026-11-19 16:58:03'
function kyivParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

export const today = () => kyivParts().date;
export const nowDateTime = () => {
  const p = kyivParts();
  return `${p.date} ${p.time}`;
};

// Чи це справжня дата у форматі YYYY-MM-DD (2026-02-30 — ні)
export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const toUtc = (value) => {
  const [y, m, d] = value.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

export function addDays(value, days) {
  return new Date(toUtc(value) + days * 86400000).toISOString().slice(0, 10);
}

export function addYears(value, years) {
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y + years, m - 1, d));
  // 29 лютого + 1 рік → 1 березня
  return dt.toISOString().slice(0, 10);
}

// Скільки днів між двома датами (кількість ночей)
export const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / 86400000);

// Усі ночі проживання: від check_in до check_out мінус 1 день
export function nightsOf(checkIn, checkOut) {
  const result = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) result.push(d);
  return result;
}

// Скільки годин залишилось до заїзду (check_in о 14:00 за Києвом)
export function hoursUntilCheckIn(checkIn) {
  const now = kyivParts();
  const [h, mi, s] = now.time.split(':').map(Number);
  const nowMs = toUtc(now.date) + ((h * 60 + mi) * 60 + s) * 1000;
  const checkInMs = toUtc(checkIn) + 14 * 3600 * 1000;
  return (checkInMs - nowMs) / 3600000;
}
