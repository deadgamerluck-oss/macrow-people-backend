# Implementation audit and verification

## Scope

This release continues the existing Macrow People React/Node/SQLite application. It retains existing application features and stored records while adding employee bio/photo fields, employee-scoped attendance/leave/payroll views, easier multi-row task assignment, date-wise work updates, image company notices, notification destinations, civic calendar context, weekend/holiday-aware leave calculations, monthly payroll draft preparation, and signed payslip output.

## Route and feature map

| Area | Main API/UI surface | Scope summary |
|---|---|---|
| Authentication | `/api/auth/*`, invite acceptance | Session authentication, password hashing, CSRF on mutations, invite activation |
| Dashboard | `/api/dashboard` | Role-aware counts and team data |
| Workforce | `/api/hrm/employees*`, employee profile | Employee list, onboarding/invites, profile and role-scoped access |
| Attendance | `/api/attendance*` | Clock, pause/resume, work sessions and activity |
| Leave/calendar | `/api/leave*`, calendar routes | Admin-managed rules, requests and approvals |
| Work management | task, project, daily-update routes | Employee updates, manager review, assignment and history |
| Payroll | payroll run, payslip, adjustment/report routes | Draft/review/approval/publish flows and day calculation |
| Bank review | `/api/hrm/bank*` | Masked/encrypted bank details and authorized review |
| Company hub | updates, events, policy routes | Announcements, calendar and private policies |
| Administration | settings, audit, SMTP diagnostic | Privileged configuration and audit views |

The public first-admin setup routes have been removed. First-admin creation and recovery are local CLI operations.

## Role-permission summary

| Role | Intended access |
|---|---|
| Admin | Full workforce and company administration, invitations, approvals, payroll/security settings, bank review and audit |
| HR Manager | Employee lifecycle, onboarding, HR workflows and scoped employee profile actions; no Admin-only settings |
| Payroll Manager | Payroll and bank verification/reveal workflows, with sensitive actions audited |
| Department Manager | Team-scoped work/attendance/update views and reviews, based on department checks |
| Employee | Own profile-permitted updates, attendance, leave, assigned work, announcements and own published payslips |

Backend handlers are authoritative; hiding a navigation entry is not the security boundary.

## Data and integration notes

- SQLite remains the system of record; schema upgrades are additive/idempotent where introduced here.
- Employee identity remains linked to the authenticated user ID. Missing employee codes are backfilled as stable `MAC-EMP-####` values; existing nonempty codes are preserved. A unique index is added only when existing values do not conflict.
- Invitation records gain correlation and SMTP message identifiers. Status reflects SMTP acceptance/failure, not inbox delivery.
- Mail delivery uses Nodemailer and protected environment configuration. No live provider credentials are part of this release.
- Bank account data remains encrypted; production backups must include both database and encryption key.

## Risk register

| Risk | Current control | Remaining action |
|---|---|---|
| SMTP credential or connectivity failure | Authenticated diagnostic, sanitized error and retry | Configure and test with production provider/domain |
| Activation URL leakage | No token logging; link only after explicit fallback consent | Share fallback only through a secured channel |
| Admin account compromise/loss | CLI-only first provisioning/recovery; password hashing and session revocation | Restrict server CLI and backup access; consider MFA before broad rollout |
| Payroll rule mismatch | Draft validation and human review; manual preview separated | Validate local rules with payroll professional and known cases |
| Database/key loss | Key stored with data; backup guidance | Complete an isolated restore drill and operational retention policy |
| Uncovered workflow regressions | Existing 9-test regression suite passes | Expand full role and browser end-to-end coverage before production |

## Verification evidence

Executed on 2026-10-19 using Node.js 24 for this release pass:

- `npm run check` — passed (`node --check server.js` and `node --check upgrades.js`).
- `npm run build` — passed with Vite 8.3.4; production React assets were generated.
- `npm test` was not run during this pass. Existing tests remain in the `test/` directory.
- SMTP provider delivery, live browser/API workflows, production HTTPS/domain configuration and database restore were not executed here.

## Known gaps

The brief's broad Definition of Done is not fully achieved. Existing routes/screens provide substantial HRMS functionality, but there is no verified complete CRUD master-data suite for departments/designations/clients/projects, document lifecycle and acknowledgement management, full performance-management workflow, statutory payroll setup, payment reconciliation, SMTP bounce webhooks, independent security review, or disaster-recovery drill. These require further implementation or owner verification. Do not interpret this release as production certified.

Company holidays remain Admin-managed because India's official holiday lists vary by state, year, and the relevant central/state circular. Civic observances are informational and are not automatically counted as paid company holidays. Payroll drafts use configured salary structures and deductions, and still require the existing human validation/approval workflow.

