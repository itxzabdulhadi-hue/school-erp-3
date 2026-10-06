# School ERP

A white-label school operations workspace backed by PostgreSQL. The React application is served by Vite in development and by the Express API after a production build. The browser only accesses school records through authenticated `/api` routes; the database connection and server-side configuration remain on the server.

## Requirements

- Node.js 20 or newer
- npm
- PostgreSQL 14 or newer
- A persistent writable server storage directory (private/public uploads and, when used, the server-only installation configuration file)

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
```

Open the Vite URL printed by the dev server. The first-run wizard verifies PostgreSQL, applies the ordered SQL migrations, creates the school and academic calendar, and provisions the first school administrator. It will not repeat setup after the installation state has been saved.

### Database configuration

Either set `DATABASE_URL` in the server environment before startup, or use the first-run database form. If the wizard is used, the URL is stored outside the browser in `STORAGE_DIR/installation.json` with restrictive file permissions (it is not encrypted by the application). Persist and back up `STORAGE_DIR` across restarts; it also contains private uploads. Use encrypted storage volumes and tightly control server filesystem access in production. Do not commit `.env`, the storage directory, database credentials, or backups.

`DATABASE_URL` must use PostgreSQL. The server rejects non-PostgreSQL protocols. Configure PostgreSQL TLS in the connection URL/provider settings for remote databases. For production, prefer a managed secret/environment variable for `DATABASE_URL`, set a stable `SESSION_SECRET`, and place the app behind HTTPS.

## Production

```sh
npm run build
npm start
```

The server listens on `PORT` (default `3001`) and serves `dist/` when present. `npm run dev` starts the API on port `3001` and Vite on port `5173`; Vite proxies `/api` and `/uploads` to the API, so browser requests remain same-origin.

## Migrations and validation

SQL migrations in `server/migrations/` run in filename order under a PostgreSQL advisory lock and are recorded in `schema_migrations`. New changes should be added as a new, forward-only migration rather than editing a migration that may already have been applied. The initial schema covers schools, users/roles/permissions, people, academics, finance, communication, library, transport, inventory, student services, documents, notifications and audit history.

```sh
npm test
npm run build
npm audit
```

## Application areas

The workspace includes first-run setup, authentication and role-based portals for school administrators, principals, teachers, students, staff, accountants, librarians and transport managers. Connected areas include people and enrollment, class/subject structure, attendance, timetable, exams and released results, assignments and materials, fee structures/invoices/payments, announcements and events, leave, library, transport, inventory, discipline, reports, audit history, school branding and regional preferences.

Access is enforced by server permissions as well as the role-specific navigation. Queries are school-scoped, teacher/student-facing academic requests are scoped to the signed-in person, and student exam results are withheld until a school administrator or principal releases them. Uploaded record documents are stored privately and downloaded through an authorized API route; public branding images are content-verified before serving.

## Operational notes

- Keep PostgreSQL and `STORAGE_DIR` backups encrypted and access-controlled.
- Restrict the setup wizard and server port at the infrastructure layer once deployment is initialized.
- Configure a stable `SESSION_SECRET`; otherwise the server securely generates one in its private install configuration.
- Configure a reverse proxy/TLS termination and suitable database connection limits for production traffic.
- Use the audit trail and school reports for operational review; export files may contain personal information.
