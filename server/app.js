import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { seedOrders } from './seed.js';

const scrypt = promisify(scryptCallback);
// OWASP's N=2^15/r=8/p=3 profile keeps memory bounded while resisting offline guessing.
const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const SESSION_MS = 7 * 86400000;
const hash = value => createHash('sha256').update(value).digest('hex');
const safeEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const userShape = row => ({ id: row.id, name: row.name, email: row.email, storeName: row.store_name, isDemo: !!row.is_demo });
// Store money as integer centimes; expose all API amounts in DZD.
const orderShape = row => ({ id: row.id, customer: row.customer, phone: row.phone, email: row.email, wilaya: row.wilaya, address: row.address, product: row.product, quantity: row.quantity, amount: row.amount / 100, status: row.status, carrier: row.carrier, createdAt: row.created_at, updatedAt: row.updated_at, events: JSON.parse(row.events) });
const text = (max = 100) => z.string().trim().min(1).max(max);
const phone = z.string().trim().transform(value => value.replace(/[\s()-]/g, '')).pipe(z.string().regex(/^(?:\+213[567]\d{8}|0[567]\d{8})$/, 'Enter a valid Algerian mobile number')).transform(value => value.startsWith('0') ? `+213${value.slice(1)}` : value);
const email = z.string().trim().toLowerCase().email().max(254);
const registerSchema = z.object({ name: text(80), email, password: z.string().min(12).max(128), storeName: text(100) }).strict();
const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
const orderSchema = z.object({ customer: text(100), phone, email: z.union([email, z.literal('')]).optional().default(''), wilaya: text(80), address: text(250), product: text(150), quantity: z.number().int().min(1).max(999), amount: z.number().positive().max(100000000).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.0001, 'Use at most two decimal places'), carrier: text(50).optional().default('Yalidine') }).strict();
const transitions = { pending: ['confirmed', 'cancelled'], confirmed: ['shipped', 'cancelled'], shipped: ['delivered', 'returned'], delivered: [], returned: [], cancelled: [] };
const patchSchema = z.object({ status: z.enum(['pending', 'confirmed', 'shipped', 'delivered', 'returned', 'cancelled']).optional(), carrier: text(50).optional() }).strict().refine(value => Object.keys(value).length > 0, 'Provide a status or carrier');

function parse(schema, body, res) {
  const result = schema.safeParse(body);
  if (!result.success) { res.status(400).json({ error: result.error.issues[0].message, details: result.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) }); return null; }
  return result.data;
}

export function createApp(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const enableDemo = options.enableDemo ?? (process.env.ENABLE_DEMO ? process.env.ENABLE_DEMO === 'true' : !production);
  const appOrigin = options.appOrigin ?? process.env.APP_ORIGIN;
  if (production && !appOrigin) throw new Error('APP_ORIGIN is required in production (e.g. https://app.example.com)');
  const originUrl = appOrigin ? new URL(appOrigin) : null;
  if (originUrl && (originUrl.username || originUrl.password || originUrl.pathname !== '/' || originUrl.search || originUrl.hash || !['http:', 'https:'].includes(originUrl.protocol))) throw new Error('APP_ORIGIN must be a clean HTTP(S) origin without credentials, path, query, or fragment');
  if (production && originUrl.protocol !== 'https:') throw new Error('APP_ORIGIN must use HTTPS in production');
  const expectedOrigin = originUrl?.origin ?? null;
  const dbPath = options.dbPath ?? process.env.DATABASE_PATH ?? resolve('data/commerce.sqlite');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT, store_name TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS orders (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, customer TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', wilaya TEXT NOT NULL, address TEXT NOT NULL, product TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), amount INTEGER NOT NULL CHECK(amount>0 AND typeof(amount)='integer'), status TEXT NOT NULL CHECK(status IN ('pending','confirmed','shipped','delivered','returned','cancelled')), carrier TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, events TEXT NOT NULL, PRIMARY KEY(user_id,id));
    CREATE INDEX IF NOT EXISTS orders_user_created ON orders(user_id,created_at DESC);
  `);
  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https://images.unsplash.com'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: production ? [] : null } } }));
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    const allowed = expectedOrigin ?? `${req.protocol}://${req.get('host')}`;
    if ((origin && origin !== allowed) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Request origin is not allowed' });
    next();
  });
  const authLimiter = rateLimit({ windowMs: 15 * 60000, limit: options.authLimit ?? 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many authentication attempts. Please try again later.' } });
  const writeLimiter = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Please try again shortly.' } });
  app.use('/api', (req, res, next) => ['GET', 'HEAD'].includes(req.method) ? next() : writeLimiter(req, res, next));
  const cookieName = production ? '__Host-dz_session' : 'dz_session';
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax', path: '/' };
  function authenticate(req, res, next) {
    const token = req.cookies[cookieName];
    if (!token || typeof token !== 'string' || token.length !== 64) return res.status(401).json({ error: 'Please sign in to continue' });
    const session = db.prepare('SELECT sessions.*, users.name, users.email, users.store_name, users.is_demo FROM sessions JOIN users ON sessions.user_id=users.id WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
    if (!session) { res.clearCookie(cookieName, cookieOptions); return res.status(401).json({ error: 'Your session has expired. Please sign in again.' }); }
    req.session = session;
    req.userId = session.user_id;
    next();
  }
  function csrf(req, res, next) {
    if (!safeEqual(req.get('x-csrf-token'), req.session.csrf_token)) return res.status(403).json({ error: 'Invalid security token. Refresh the page and try again.' });
    next();
  }
  function createSession(req, res, user, status = 200) {
    const oldToken = req.cookies[cookieName];
    if (typeof oldToken === 'string') db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(oldToken));
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)').run(hash(token), user.id, csrfToken, Date.now() + SESSION_MS);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: SESSION_MS });
    return res.status(status).json({ user: userShape(user), csrfToken });
  }
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/api/auth/demo', authLimiter, (req, res) => {
    if (!enableDemo) return res.status(403).json({ error: 'Demo access is disabled. Please sign in or create an account.' });
    db.prepare('DELETE FROM users WHERE is_demo=1 AND created_at<?').run(new Date(Date.now() - 86400000).toISOString());
    const user = { id: randomUUID(), name: 'Yasmine Benali', email: `demo-${randomBytes(8).toString('hex')}@example.com`, store_name: 'Maison DZ', is_demo: 1 };
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO users(id,name,email,store_name,is_demo,created_at) VALUES(?,?,?,?,1,?)').run(user.id, user.name, user.email, user.store_name, new Date().toISOString());
      seedOrders(db, user.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    createSession(req, res, user, 201);
  });
  app.post('/api/auth/register', authLimiter, async (req, res, next) => {
    const input = parse(registerSchema, req.body, res);
    if (!input) return;
    try {
      const salt = randomBytes(16).toString('hex');
      const derived = await scrypt(input.password, salt, 64, scryptOptions);
      const user = { id: randomUUID(), name: input.name, email: input.email, store_name: input.storeName, is_demo: 0 };
      try { db.prepare('INSERT INTO users(id,name,email,password_hash,store_name,created_at) VALUES(?,?,?,?,?,?)').run(user.id, user.name, user.email, `${salt}:${derived.toString('hex')}`, user.store_name, new Date().toISOString()); }
      catch (error) { if (error.code?.includes('CONSTRAINT') || String(error.message).includes('UNIQUE constraint')) return res.status(409).json({ error: 'An account with this email already exists' }); throw error; }
      createSession(req, res, user, 201);
    } catch (error) { next(error); }
  });
  const dummySalt = randomBytes(16).toString('hex');
  app.post('/api/auth/login', authLimiter, async (req, res, next) => {
    const input = parse(loginSchema, req.body, res);
    if (!input) return;
    try {
      const user = db.prepare('SELECT * FROM users WHERE email=? AND is_demo=0').get(input.email);
      const [salt, expected] = user?.password_hash?.split(':') ?? [dummySalt, '0'.repeat(128)];
      const derived = await scrypt(input.password, salt, 64, scryptOptions);
      if (!safeEqual(derived.toString('hex'), expected) || !user) return res.status(401).json({ error: 'Email or password is incorrect' });
      createSession(req, res, user);
    } catch (error) { next(error); }
  });
  app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: userShape({ ...req.session, id: req.userId }), csrfToken: req.session.csrf_token }));
  app.post('/api/auth/logout', authenticate, csrf, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session.token_hash);
    res.clearCookie(cookieName, cookieOptions);
    res.json({ ok: true });
  });
  app.get('/api/orders', authenticate, (req, res) => {
    const orders = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(req.userId).map(orderShape);
    res.json({ orders });
  });
  app.post('/api/orders', authenticate, csrf, (req, res) => {
    const input = parse(orderSchema, req.body, res);
    if (!input) return;
    let id;
    do { id = `DZ-${randomBytes(8).toString('hex').toUpperCase()}`; }
    while (db.prepare('SELECT 1 FROM orders WHERE user_id=? AND id=?').get(req.userId, id));
    const now = new Date().toISOString();
    db.prepare('INSERT INTO orders(user_id,id,customer,phone,email,wilaya,address,product,quantity,amount,status,carrier,created_at,updated_at,events) VALUES(?,?,?,?,?,?,?,?,?,?,\'pending\',?,?,?,?)').run(req.userId, id, input.customer, input.phone, input.email, input.wilaya, input.address, input.product, input.quantity, Math.round(input.amount * 100), input.carrier, now, now, JSON.stringify([{ status: 'pending', at: now }]));
    res.status(201).json({ order: orderShape(db.prepare('SELECT * FROM orders WHERE user_id=? AND id=?').get(req.userId, id)) });
  });
  app.patch('/api/orders/:id', authenticate, csrf, (req, res) => {
    const input = parse(patchSchema, req.body, res);
    if (!input) return;
    const row = db.prepare('SELECT * FROM orders WHERE user_id=? AND id=?').get(req.userId, req.params.id);
    if (!row) return res.status(404).json({ error: 'Order not found' });
    if (input.status && input.status !== row.status && !transitions[row.status].includes(input.status)) return res.status(409).json({ error: `An order cannot move from ${row.status} to ${input.status}` });
    const now = new Date().toISOString();
    const events = JSON.parse(row.events);
    if (input.status && input.status !== row.status) events.push({ status: input.status, at: now });
    db.prepare('UPDATE orders SET status=?,carrier=?,updated_at=?,events=? WHERE user_id=? AND id=?').run(input.status ?? row.status, input.carrier ?? row.carrier, now, JSON.stringify(events), req.userId, row.id);
    res.json({ order: orderShape(db.prepare('SELECT * FROM orders WHERE user_id=? AND id=?').get(req.userId, row.id)) });
  });
  app.get('/api/customers', authenticate, (req, res) => {
    const rows = db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(req.userId);
    const byPhone = new Map();
    for (const row of rows) {
      if (!byPhone.has(row.phone)) byPhone.set(row.phone, { id: row.phone, name: row.customer, phone: row.phone, email: row.email, wilaya: row.wilaya, orders: 0, totalSpent: 0, lastOrder: row.created_at });
      const customer = byPhone.get(row.phone);
      customer.orders++;
      if (row.status === 'delivered') customer.totalSpent += row.amount;
    }
    res.json({ customers: [...byPhone.values()].map(customer => ({ ...customer, totalSpent: customer.totalSpent / 100 })) });
  });
  app.patch('/api/settings', authenticate, csrf, (req, res) => {
    const input = parse(z.object({ storeName: text(100), name: text(80) }).strict(), req.body, res);
    if (!input) return;
    db.prepare('UPDATE users SET name=?,store_name=? WHERE id=?').run(input.name, input.storeName, req.userId);
    res.json({ user: userShape(db.prepare('SELECT * FROM users WHERE id=?').get(req.userId)) });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: production ? '1h' : 0 }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Request body must be valid JSON' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
    console.error('API error:', error.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}
