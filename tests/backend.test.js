import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

let app;
beforeEach(() => { app = createApp({ dbPath: ':memory:', enableDemo: true, production: false, authLimit: 1000 }); });
afterEach(() => { app.locals.db.close(); });
const credentials = { name: 'Yasmine Benali', email: 'yasmine@example.com', password: 'a-very-long-password', storeName: 'Maison DZ' };
const order = { customer: 'Amine Benali', phone: '0555 123 456', email: 'amine@example.com', wilaya: 'Alger', address: '12 Rue des Oliviers', product: 'Ceramic coffee set', quantity: 2, amount: 11600, carrier: 'Yalidine' };
async function register(agent, suffix = '') {
  const response = await agent.post('/api/auth/register').send({ ...credentials, email: `yasmine${suffix}@example.com` }).expect(201);
  return response.body;
}

test('protected endpoints reject anonymous requests', async () => {
  await request(app).get('/api/orders').expect(401);
  await request(app).get('/api/customers').expect(401);
  await request(app).get('/api/auth/me').expect(401);
  await request(app).post('/api/orders').send(order).expect(401);
});

test('registration creates a private empty workspace and a secure session', async () => {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/register').send(credentials).expect(201);
  assert.equal(response.body.user.storeName, 'Maison DZ');
  assert.equal(response.body.user.isDemo, false);
  assert.equal(response.body.csrfToken.length, 64);
  const cookie = response.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.ok(!JSON.stringify(response.body).includes('password_hash'));
  assert.deepEqual((await agent.get('/api/orders').expect(200)).body.orders, []);
  assert.equal((await agent.get('/api/auth/me').expect(200)).body.user.email, credentials.email);
  const dbUser = app.locals.db.prepare('SELECT password_hash FROM users WHERE email=?').get(credentials.email);
  assert.ok(dbUser.password_hash && !dbUser.password_hash.includes(credentials.password));
  assert.equal(app.locals.db.prepare('SELECT token_hash FROM sessions').get().token_hash.length, 64);
  assert.ok(!cookie.includes(app.locals.db.prepare('SELECT token_hash FROM sessions').get().token_hash));
});

test('login verifies password, rotates sessions, and logout invalidates it', async () => {
  const agent = request.agent(app);
  const first = await register(agent);
  const firstSession = app.locals.db.prepare('SELECT token_hash FROM sessions').get().token_hash;
  await agent.post('/api/auth/login').send({ email: credentials.email, password: 'wrong-password' }).expect(401);
  await request(app).post('/api/auth/login').send({ email: 'absent@example.com', password: 'wrong-password' }).expect(401);
  const login = await agent.post('/api/auth/login').send({ email: credentials.email.toUpperCase(), password: credentials.password }).expect(200);
  assert.notEqual(login.body.csrfToken, first.csrfToken);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.notEqual(app.locals.db.prepare('SELECT token_hash FROM sessions').get().token_hash, firstSession);
  await agent.post('/api/auth/logout').expect(403);
  await agent.post('/api/auth/logout').set('X-CSRF-Token', login.body.csrfToken).expect(200);
  await agent.get('/api/auth/me').expect(401);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('weak passwords, duplicate emails and unknown registration fields are rejected', async () => {
  await request(app).post('/api/auth/register').send({ ...credentials, password: 'short' }).expect(400);
  await request(app).post('/api/auth/register').send({ ...credentials, role: 'admin' }).expect(400);
  await register(request.agent(app));
  await request(app).post('/api/auth/register').send(credentials).expect(409);
});

test('mutations require both a CSRF token and an allowed origin', async () => {
  const agent = request.agent(app);
  const { csrfToken } = await register(agent);
  await agent.post('/api/orders').send(order).expect(403);
  await agent.post('/api/orders').set('X-CSRF-Token', 'forged').send(order).expect(403);
  await agent.post('/api/orders').set('X-CSRF-Token', csrfToken).set('Origin', 'https://attacker.example').send(order).expect(403);
  await agent.post('/api/orders').set('X-CSRF-Token', csrfToken).set('Sec-Fetch-Site', 'cross-site').send(order).expect(403);
  await request(app).post('/api/auth/login').set('Origin', 'https://attacker.example').send({ email: credentials.email, password: credentials.password }).expect(403);
});

test('valid orders persist, phone numbers normalize, and delivered customers aggregate', async () => {
  const agent = request.agent(app);
  const { csrfToken } = await register(agent);
  const created = await agent.post('/api/orders').set('X-CSRF-Token', csrfToken).send(order).expect(201);
  assert.equal(created.body.order.phone, '+213555123456');
  assert.equal(created.body.order.status, 'pending');
  assert.equal(created.body.order.events.length, 1);
  const id = created.body.order.id;
  for (const status of ['confirmed', 'shipped', 'delivered']) {
    await agent.patch(`/api/orders/${id}`).set('X-CSRF-Token', csrfToken).send({ status }).expect(200);
  }
  const persisted = (await agent.get('/api/orders').expect(200)).body.orders[0];
  assert.equal(persisted.amount, 11600);
  assert.equal(persisted.status, 'delivered');
  assert.deepEqual(persisted.events.map(event => event.status), ['pending', 'confirmed', 'shipped', 'delivered']);
  const customers = (await agent.get('/api/customers').expect(200)).body.customers;
  assert.equal(customers.length, 1);
  assert.equal(customers[0].totalSpent, 11600);
  assert.equal(customers[0].orders, 1);
});

test('status transitions cannot skip confirmation or reopen terminal orders', async () => {
  const agent = request.agent(app);
  const { csrfToken } = await register(agent);
  const id = (await agent.post('/api/orders').set('X-CSRF-Token', csrfToken).send(order).expect(201)).body.order.id;
  await agent.patch(`/api/orders/${id}`).set('X-CSRF-Token', csrfToken).send({ status: 'delivered' }).expect(409);
  await agent.patch(`/api/orders/${id}`).set('X-CSRF-Token', csrfToken).send({ status: 'cancelled' }).expect(200);
  await agent.patch(`/api/orders/${id}`).set('X-CSRF-Token', csrfToken).send({ status: 'confirmed' }).expect(409);
  await agent.patch(`/api/orders/${id}`).set('X-CSRF-Token', csrfToken).send({ status: 'invalid' }).expect(400);
  await agent.patch(`/api/orders/${id}`).set('X-CSRF-Token', csrfToken).send({}).expect(400);
});

test('fractional DZD amounts are stored as integer centimes', async () => {
  const agent = request.agent(app);
  const { csrfToken } = await register(agent);
  const created = await agent.post('/api/orders').set('X-CSRF-Token', csrfToken).send({ ...order, amount: 1999.95 }).expect(201);
  assert.equal(created.body.order.amount, 1999.95);
  assert.equal(app.locals.db.prepare('SELECT amount FROM orders WHERE id=?').get(created.body.order.id).amount, 199995);
});

test('validation rejects malformed, excessive and privileged order values', async () => {
  const agent = request.agent(app);
  const { csrfToken } = await register(agent);
  for (const invalid of [{ amount: -1 }, { amount: 1.123 }, { quantity: 0 }, { quantity: 1.5 }, { phone: '123' }, { customer: '' }, { email: 'nope' }, { status: 'delivered' }, { user_id: 'other-tenant' }]) {
    await agent.post('/api/orders').set('X-CSRF-Token', csrfToken).send({ ...order, ...invalid }).expect(400);
  }
  assert.equal((await agent.get('/api/orders')).body.orders.length, 0);
});

test('tenants cannot view or change each other’s orders or customers', async () => {
  const alice = request.agent(app);
  const bob = request.agent(app);
  const a = await register(alice, '-alice');
  const b = await register(bob, '-bob');
  const id = (await alice.post('/api/orders').set('X-CSRF-Token', a.csrfToken).send(order).expect(201)).body.order.id;
  assert.deepEqual((await bob.get('/api/orders')).body.orders, []);
  assert.deepEqual((await bob.get('/api/customers')).body.customers, []);
  await bob.patch(`/api/orders/${id}`).set('X-CSRF-Token', b.csrfToken).send({ status: 'confirmed' }).expect(404);
  await bob.patch('/api/settings').set('X-CSRF-Token', b.csrfToken).send({ name: 'Bob', storeName: 'B store' }).expect(200);
  assert.equal((await alice.get('/api/auth/me')).body.user.storeName, credentials.storeName);
});

test('demo workspaces have isolated realistic data and no effect on registered accounts', async () => {
  const first = request.agent(app);
  const second = request.agent(app);
  const a = (await first.post('/api/auth/demo').expect(201)).body;
  const b = (await second.post('/api/auth/demo').expect(201)).body;
  assert.notEqual(a.user.id, b.user.id);
  assert.equal(a.user.isDemo, true);
  const orders = (await first.get('/api/orders')).body.orders;
  assert.equal(orders.length, 126);
  assert.ok(orders.some(row => row.status === 'pending'));
  assert.ok(orders.some(row => row.status === 'delivered'));
  const pending = orders.find(row => row.status === 'pending');
  await first.patch(`/api/orders/${pending.id}`).set('X-CSRF-Token', a.csrfToken).send({ status: 'confirmed' }).expect(200);
  assert.equal((await second.get('/api/orders')).body.orders.find(row => row.id === pending.id).status, 'pending');
});

test('expired sessions are rejected', async () => {
  const agent = request.agent(app);
  await register(agent);
  app.locals.db.prepare('UPDATE sessions SET expires_at=?').run(Date.now() - 1);
  await agent.get('/api/orders').expect(401);
});

test('production requires an explicit origin, defaults demo off, and marks cookies Secure', async () => {
  assert.throws(() => createApp({ dbPath: ':memory:', production: true }), /APP_ORIGIN/);
  assert.throws(() => createApp({ dbPath: ':memory:', production: true, appOrigin: 'http://example.com' }), /HTTPS/);
  assert.throws(() => createApp({ dbPath: ':memory:', production: true, appOrigin: 'https://user:pass@example.com/path' }), /clean/);
  const productionApp = createApp({ dbPath: ':memory:', production: true, appOrigin: 'https://dashboard.example' });
  try {
    await request(productionApp).post('/api/auth/demo').expect(403);
    const response = await request(productionApp).post('/api/auth/register').set('Origin', 'https://dashboard.example').send(credentials).expect(201);
    assert.match(response.headers['set-cookie'][0], /__Host-dz_session=/);
    assert.match(response.headers['set-cookie'][0], /; Secure/);
    await request(productionApp).post('/api/auth/register').set('Origin', 'https://evil.example').send(credentials).expect(403);
  } finally { productionApp.locals.db.close(); }
});

test('file-backed databases use owner-only file and new-directory permissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'darja-db-test-'));
  const dbPath = join(directory, 'private', 'commerce.sqlite');
  const fileApp = createApp({ dbPath, production: false });
  try {
    assert.equal(statSync(dbPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, 'private')).mode & 0o777, 0o700);
  } finally { fileApp.locals.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('accounts, sessions and orders survive an application restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'darja-persistence-test-'));
  const dbPath = join(directory, 'commerce.sqlite');
  let persistentApp = createApp({ dbPath, production: false });
  try {
    const registration = await request(persistentApp).post('/api/auth/register').send(credentials).expect(201);
    const cookie = registration.headers['set-cookie'][0].split(';')[0];
    await request(persistentApp).post('/api/orders').set('Cookie', cookie).set('X-CSRF-Token', registration.body.csrfToken).send(order).expect(201);
    persistentApp.locals.db.close();
    persistentApp = createApp({ dbPath, production: false });
    const response = await request(persistentApp).get('/api/orders').set('Cookie', cookie).expect(200);
    assert.equal(response.body.orders.length, 1);
    assert.equal(response.body.orders[0].customer, order.customer);
    assert.equal(response.body.orders[0].amount, order.amount);
    await request(persistentApp).get('/api/auth/me').set('Cookie', cookie).expect(200);
  } finally { persistentApp.locals.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('rate limiting bounds authentication attempts', async () => {
  const limitedApp = createApp({ dbPath: ':memory:', production: false, authLimit: 1 });
  try {
    await request(limitedApp).post('/api/auth/login').send({ email: credentials.email, password: 'incorrect' }).expect(401);
    await request(limitedApp).post('/api/auth/login').send({ email: credentials.email, password: 'incorrect' }).expect(429);
  } finally { limitedApp.locals.db.close(); }
});

test('errors remain JSON and sensitive responses are not cached', async () => {
  await request(app).post('/api/auth/register').set('Content-Type', 'application/json').send('{malformed').expect(400);
  const response = await request(app).get('/api/no-such-endpoint').expect(404);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.error, 'API endpoint not found');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});
