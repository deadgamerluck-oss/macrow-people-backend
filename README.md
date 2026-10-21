# Macrow People — React HRMS

Macrow People is an internal HRMS for Macrow Digital. The frontend is React 19/Vite and the API is Node.js 24 with SQLite.

## Requirements

- Node.js 24 or newer
- npm
- SMTP credentials for real invitation delivery

## Install and run

```powershell
npm install
Copy-Item .env.example .env
# Edit .env and set APP_BASE_URL and the SMTP values (keep .env private).
npm run build
npm start
```

Open `http://127.0.0.1:3000`. The service binds to localhost by default. For remote use, deploy behind HTTPS and set `HOST`/`PORT` for the private application network. Set `APP_BASE_URL` to the externally reachable HTTPS URL.

## First administrator

The browser setup-token flow and public setup endpoints have been removed. On a fresh database, provision the first administrator from an interactive terminal:

```powershell
npm run provision:admin
```

The command prompts for name, email, and password without echoing the password. It refuses to create a second Admin. For an existing installation where the only Admin has lost access, use the separate recovery command:

```powershell
npm run recover:admin
```

Recovery resets the password for the existing Admin account, activates that account, revokes its sessions, and writes an audit event. It will not create an Admin. Run these commands on the machine that owns the database, using the same environment and data directory as the service. Protect terminal access and database backups.

## Invitations and SMTP

Copy `.env.example` to a protected `.env` (or inject values through your deployment secret manager). Configure `APP_BASE_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`. For port 587, `SMTP_SECURE=false` uses STARTTLS; for implicit TLS such as port 465, set `SMTP_SECURE=true`. Restart the server after changing configuration.

The Admin Settings page offers an authenticated SMTP connection/authentication diagnostic. Invite and resend actions persist `sent` only when SMTP accepts the message. Acceptance does not prove inbox delivery. Failures are recorded as failed with a correlation ID; Admin/HR can retry or revoke an invite. An activation URL is shown only if the administrator explicitly authorized link fallback for that action. Invite tokens are not written to logs. Use an authenticated, secured channel if sharing a fallback URL.

## Data, backups and restore

SQLite data and the AES-256-GCM bank encryption key are stored in `data/` by default. `HRMS_DATA_DIR` can point both CLI commands and the service to a protected data directory. Back up the entire data directory, including the encryption key, together; a database-only backup cannot decrypt bank records. Restrict access to the server account and backups. Test restoration into an isolated environment before relying on backups. Never commit `.env`, `data/`, database files, encryption keys, or uploaded private documents.

For a rollback, stop the service, preserve a copy of the current data directory, restore the database and encryption key from the same backup set, then deploy the previous application version. Schema upgrades run idempotently on startup; review the current schema and backup before deploying an older version against a newer database.

## Current feature areas

- Role-aware navigation and dashboards for Admin, HR, Payroll, Department Manager, and Employee.
- Employee invitations, onboarding status, profiles, employee IDs, location/work arrangement, account controls, and profile history.
- Attendance clock-in, pause, resume, clock-out, timer, reason collection for early clock-out, and activity history.
- Admin attendance corrections support Present, Half day, and Absent statuses with optional corrected times and notes; editable payroll drafts recalculate after changes.
- Admin-managed leave categories, employee requests, approval flows, balances, and calendar events.
- Tasks, daily work updates and history, projects/client references, manager review, announcements, notifications, and policy documents.
- Payroll structures, attendance-based payable days, draft runs, validation, review/approval, finalization, publication, adjustments, reports and payslips, subject to configured company rules.
- Encrypted employee bank details, masked review data, authorized reveal, verification workflow, and audit history.
- Reports, CSV exports, SMTP diagnostics, audit events, and Admin/HR invitation retry and revocation.

## Important payroll boundaries

Payroll is a human-reviewed calculation and recordkeeping workflow, not a payment processor or legal compliance engine. Configure company-approved rules and review statutory deductions with a qualified payroll professional. Validate calculations against known cases before entering real payroll data. The manual payslip preview is separate from official payroll records and is labelled as a preview.

## Security and deployment

Passwords use salted scrypt hashes; opaque session tokens are stored as hashes. Mutating API requests use CSRF protection. Session cookies are HttpOnly and SameSite=Lax; production mode enables Secure cookies. Login attempts are rate limited. Bank data is encrypted at rest. The server avoids logging request bodies, passwords, SMTP credentials, session tokens, and invite tokens. Use HTTPS, a private database host, least-privilege file permissions, domain-authenticated email, monitored backups, and a dedicated service account in production. Do not expose the SQLite file or raw application port publicly.

This code has not undergone an independent security audit or legal/payroll certification.

## Commands

- `npm start` — run the API and built frontend.
- `npm run dev` — run Vite development server; run the API separately.
- `npm run build` — build React assets into `public/`.
- `npm run check` — syntax-check the Node API and upgrades.
- `npm test` — run the existing Node regression suite.
- `npm run provision:admin` — securely create the first Admin on a fresh instance.
- `npm run recover:admin` — recover an existing Admin account.

## Known limitations to review before production

This release has not been validated against a live SMTP provider or production domain in this environment. The available regression suite is focused and does not constitute full end-to-end coverage of every role or workflow. Department/designation/client/project master-data administration, employee document lifecycle/acknowledgements, full performance management, statutory payroll configuration, payment reconciliation, provider bounce webhooks, and a disaster-recovery restore drill remain incomplete or need product/operations validation. Treat listed feature areas as existing code paths, not as a claim of production readiness. See `IMPLEMENTATION_AUDIT.md` and `HANDOVER.md` for evidence and release gates.
