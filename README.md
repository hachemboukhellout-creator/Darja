# Darja

![Darja dashboard](./artifacts/dashboard-desktop.jpg)

[Mobile preview](./artifacts/dashboard-mobile.jpg) · [Implementation plan](./IMPLEMENTATION_PLAN.md)

A responsive commerce workspace for Algerian stores, built with React, TypeScript, Vite, Express and SQLite. The repository was empty at the start; the implementation plan is in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## Run locally

Requires **Node.js 24** and npm. The server uses Node's built-in `node:sqlite`, which may print an experimental-feature warning.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Vite forwards `/api` requests to the API on port 3001. Both processes run with `npm run dev`; the API must be running for the dashboard to work.

Development opens an isolated demo workspace automatically. Each new demo has 126 sample orders and 24 customer profiles. Demo data is private to that session and persisted in SQLite; demo accounts older than 24 hours are cleaned up when another demo is created. Create an account to start with an empty workspace. There are no default live-account credentials. Registration requires a password of at least 12 characters.

```bash
npm run check
npm test
npm run build
```

Browser tests use Playwright:

```bash
npx playwright install chromium
npm run test:e2e
```

The browser configuration uses `/usr/bin/chromium` when available, otherwise the Playwright-installed browser. Set `PLAYWRIGHT_CHROMIUM_PATH` to override it.

The API tests use isolated in-memory or temporary databases. They exercise anonymous access, registration, password verification, session rotation/revocation/expiry, CSRF and origin checks, cross-store isolation, validation, order transitions, customer aggregates, centime accuracy, disk persistence, cookie flags and authentication throttling. Verified in the implementation environment: production build/type checking, all 17 API tests, and all 3 Playwright browser tests passed. Browser tests cover order creation through delivery, persistence and customer summaries, registration/settings/sign-in, and mobile navigation/analytics.

## Core workflows

- **Overview:** order revenue, volume, outstanding confirmations, delivery success, current/prior-period charts and recent orders.
- **Orders:** create cash-on-delivery orders, search by order/customer/phone/product/wilaya, filter status, inspect details and export CSV. Amount is the **whole order total in DZD**, not a unit price.
- **COD confirmation:** open a customer's phone link, verify the delivery details and confirm the order. This does not place an automated call or send a message.
- **Deliveries:** prepare, ship and complete a delivery; review persisted status history. Carrier statuses are updated manually.
- **Customers:** profiles grouped by normalized Algerian mobile number, order history and collected spend. Profiles are derived from orders.
- **Analytics:** revenue, delivery outcomes, average order value and top wilayas, calculated from stored orders.
- **Settings and accounts:** update the owner/store name, register, sign in and sign out. Currency and market are Algeria/DZD.

Valid status transitions:

```text
pending   → confirmed → shipped → delivered
   │            │           └──→ returned
   └─ cancelled ←┘
```

Delivered, returned and cancelled orders are terminal. Repeating an existing status does not create a duplicate history event. The server validates transitions independently of the interface.

Order-revenue analytics exclude cancelled and returned orders; they include outstanding COD orders. Collected revenue/customer spend includes delivered orders only. Currency is stored as integer centimes in SQLite and exposed as DZD through the API.

## Configuration

The server reads process environment variables. `.env` files are **not loaded automatically** by the npm scripts. The example file can be loaded explicitly with Node:

```bash
cp .env.example .env
node --env-file=.env server/index.js
```

For development, run Vite separately when starting the API this way: `npx vite --host 0.0.0.0`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Express listener port; the development proxy expects 3001. |
| `DATABASE_PATH` | `data/commerce.sqlite` | Persistent database file, relative to the working directory unless absolute. |
| `NODE_ENV` | development behavior when unset | Set to `production` for secure cookies and production checks. |
| `APP_ORIGIN` | inferred from request in development | Required in production; an HTTPS origin such as `https://app.example.dz`, without a path, query or credentials. |
| `ENABLE_DEMO` | enabled outside production | Set `false` to disable sample workspaces. Production defaults to disabled; explicit `true` enables it. |

Do not put server configuration or credentials in `VITE_*` variables; those are exposed to browsers. Database files, environment files and build/test artifacts are ignored by git.

## Authentication and API

Passwords use salted scrypt (`N=32768`, `r=8`, `p=3`). Sessions use random opaque tokens stored as hashes on the server, with a seven-day expiry. The browser receives an HttpOnly, SameSite=Lax cookie; production uses a Secure, host-only `__Host-` cookie. Signing in rotates the current browser session, and signing out revokes it server-side. Authentication responses include a CSRF token held in browser memory and sent as `X-CSRF-Token` on authenticated mutations.

All order/customer/settings access is scoped to the authenticated owner. Requests use schema validation, parameterized SQL, request-size limits, origin checks, security headers and in-memory rate limits. No browser-local storage contains credentials, session tokens or order data.

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/health` | Process health response. |
| POST | `/api/auth/demo` | Create an isolated seeded demo, when enabled. |
| POST | `/api/auth/register` | `{name, email, password, storeName}`; create an empty workspace. |
| POST | `/api/auth/login` | `{email, password}`; create a session. |
| GET | `/api/auth/me` | Current `{user, csrfToken}`. |
| POST | `/api/auth/logout` | Revoke current session; requires CSRF header. |
| GET / POST | `/api/orders` | List / create the current store's orders. |
| PATCH | `/api/orders/:id` | Update status and/or carrier. |
| GET | `/api/customers` | Customer aggregates for the current store. |
| PATCH | `/api/settings` | Update `{name, storeName}`. |

Order creation accepts `customer`, `phone`, optional `email`, `wilaya`, `address`, `product`, integer `quantity`, positive DZD `amount` with up to two decimal places, and optional `carrier`. New orders always begin pending. Algerian mobile numbers beginning `05`, `06`, `07` or `+2135`, `+2136`, `+2137` normalize to the international format. API errors return JSON containing `error` and, for validation failures, field details.

## Before production deployment

Build the application, then serve it through the API behind a TLS reverse proxy:

```bash
npm run build
APP_ORIGIN=https://app.example.dz ENABLE_DEMO=false DATABASE_PATH=/persistent/darja/commerce.sqlite npm start
```

`npm start` enables production mode. Express serves `dist/` and the API from the same origin. A local HTTP browser will not retain production Secure cookies; use real HTTPS termination and the configured public origin.

Complete these deployment and product tasks before accepting real customer data:

1. **Hosting and data operations:** mount a persistent, private database directory; establish SQLite-consistent backups and restoration tests; add versioned schema migrations, monitoring, error reporting and operational runbooks. Use one application instance with SQLite; plan PostgreSQL and distributed session/rate-limit storage for multiple replicas.
2. **Proxy and security configuration:** set the correct HTTPS origin, disable demo access, restrict direct access to the API and configure an explicit trusted proxy policy. The current rate limiter sees the connection IP, so an unconfigured reverse proxy can group every customer into one limit. Run a security review and dependency audit against the final deployment.
3. **Account lifecycle:** add email verification, verified password recovery, MFA, account deletion/export and protections appropriate to public registration. No email delivery provider is configured.
4. **Team administration:** add workspace membership, staff roles, permissions and an audit log before allowing multiple operators. This version has one owner per workspace.
5. **Commerce integrations:** connect real carrier APIs/webhooks with signature validation, idempotency and retries; reconcile COD collections/remittances; connect storefront order imports. Add SMS/WhatsApp or calling integrations only with appropriate provider configuration and authorization.
6. **Product readiness:** validate French/Arabic copy and RTL layouts, accessibility, larger data volumes and supported mobile devices. Add server pagination/reporting for large stores, carrier-specific wilaya/commune rules, retention policies and legal/privacy documentation.

No storefront, carrier, SMS, email, payment or deployment provider credentials were supplied. Those external services are not connected, and the application has not been deployed to production.
