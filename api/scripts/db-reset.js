// `npm run db:reset` — повертає робочу базу hotel.local.db у початковий стан.
// Перед запуском зупини сервер (Ctrl + C), інакше Windows не дасть перезаписати файл.
import { resetDatabase } from '../src/db.js';

resetDatabase();
console.log('Готово: hotel.local.db створено заново з hotel.db (+ тестові акаунти персоналу).');
