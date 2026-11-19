// Точка входу: `npm start` запускає цей файл.
import { createServer } from 'node:http';
import { requestListener } from './app.js';
import { getDb } from './db.js';

// Підключаємо всі маршрути (кожен файл реєструє свої ендпоінти)
import './routes/auth.js';
import './routes/rooms.js';
import './routes/rates.js';
import './routes/guests.js';
import './routes/bookings.js';
import './routes/extras.js';

const PORT = Number(process.env.PORT) || 3000;

getDb(); // відкриваємо базу одразу, щоб помилка (якщо є) була видна при старті

createServer(requestListener).listen(PORT, () => {
  console.log(`Hotels API працює: http://localhost:${PORT}/api/v1`);
  console.log('Зупинити сервер: Ctrl + C');
});
