# Darja implementation plan

Repository inspection: the supplied `/workspace` contained no application, package manifest, or repository instructions. Node 24 and npm are available. This implementation starts a local React + TypeScript + Vite application with an Express API and SQLite persistence.

1. Establish typed order/customer models, responsive workspace shell and Algerian commerce visual design.
2. Implement persisted order creation, search and filters; COD confirmation; validated delivery state transitions and event history; customer rollups; analytics calculated from order data.
3. Implement tenant-scoped API access, scrypt passwords, opaque hashed server sessions, HttpOnly cookies, CSRF protection, input validation, authentication throttling and security headers. Demo workspaces contain isolated sample data; registered workspaces start empty.
4. Test authentication, invalid input, tenant isolation and status transitions at the API; exercise critical desktop/mobile workflows in a browser; build production assets and verify type checking.
5. Document local operation, demo limitations, environment settings and production deployment work.

Implementation boundaries: carrier statuses are manually managed. No external delivery, SMS, payment, email or storefront credentials have been supplied. No external messages or deployments are performed.
