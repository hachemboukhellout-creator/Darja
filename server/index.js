import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT || 3001);
const server = app.listen(port, '0.0.0.0', () => console.log(`Darja API listening on http://localhost:${port}`));

function shutdown() {
  server.close(() => { app.locals.db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
