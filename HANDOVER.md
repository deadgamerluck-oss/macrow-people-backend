# Macrow People — developer handover

## Release contents

This source release contains the React frontend, Node.js API, SQLite schema/upgrades, focused tests, `.env.example`, setup instructions, audit notes and handover. It intentionally excludes secrets, the local database, uploaded documents, `node_modules`, and Git metadata.

## Latest workforce UI and workflow additions

- Employee profile pages now include an employee-scoped bio, contact fields, skills, certifications, profile image, attendance, leave requests, work updates, tasks, payroll, and activity history. HR/Admin employee records keep each person's data together.
- Admin can add multiple dated tasks from the selected employee profile; each task remains a separate audited task record. Daily work updates are arranged by work date.
- Employee attendance includes a month calendar and date-level shift details. Early clock-out before the configured 7:00 PM IST shift end requires a reason, which is saved in attendance activity.
- Admin can correct employee attendance from Team Attendance by date, including Present, Half day, or Absent and optional clock times. Corrections are audit logged and recalculate editable payroll drafts; periods already in approval or closed require a payroll adjustment instead.
- Company updates support optional images and create employee notifications. Notification clicks open the matching role-specific page.
- Leave requests calculate eligible days on the server. Saturdays, Sundays, and Admin-entered company holidays are excluded from leave day deductions. Civic / national observances are informational and do not become company holidays automatically.
- With active salary structures, the service prepares the preceding month as a payroll Draft when the new month is detected. Payable days use recorded attendance: Present = 1 day, Half day = 0.5, and Absent/unrecorded scheduled days = 0. Admin corrections update the draft; it remains subject to the existing validation and approval workflow and is never auto-published or marked paid.
- Published payslips include the supplied Lakshman Sharma signature artwork and signer title. The payslip window supports PDF download where available and print-to-PDF as a browser fallback.

India's official holiday schedules vary by state and year. Admin should enter Macrow's actual paid holidays in Calendar; the built-in civic dates are display-only. Payroll deduction values remain Admin-configured and should be reviewed against the business's applicable payroll advice before approval.

## Quick start

1. Install Node.js 24+ and npm.
2. Extract this archive to a trusted development/server directory.
3. Run `npm install` and `npm run build`.
4. Copy `.env.example` to `.env`; configure the external HTTPS app URL and protected SMTP values.
5. On a fresh database, run `npm run provision:admin` interactively. The CLI prompts for credentials; no setup token is used.
6. Run `npm start` and sign in as Admin.
7. In Admin Settings, run the SMTP diagnostic. Invite a test account and verify actual receipt/activation before inviting the workforce.
8. Run `npm test` and `npm run check` before deployment.

## Existing installation

Stop the old service and take a full backup of the SQLite database and encryption key together before upgrading. Preserve any private policy documents. Deploy the new code with the same protected data directory and secrets. Schema migrations run on startup. Confirm role access, invite delivery, attendance, leave, payroll and bank workflows using non-production records. Keep the backup until the new release is accepted.

## First Admin recovery

Run `npm run recover:admin` in a protected interactive terminal, using the service's data directory. It requires an existing Admin row, resets that account, activates it and revokes sessions. It cannot create another Admin. Restrict command execution and terminal history/access according to the server policy.

## Environment configuration

`APP_BASE_URL`, `HOST`, `PORT`, `NODE_ENV`, `HRMS_DATA_DIR`, `HRMS_ENCRYPTION_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Keep all real secrets outside source control. Production requires HTTPS and secure server/database permissions.

## Backup and restore

1. Stop writes or use a SQLite-consistent backup procedure.
2. Copy the database, `hrms-encryption.key`, and any private documents as one protected backup set.
3. To restore, stop the service and restore that set to an isolated protected data directory.
4. Set `HRMS_DATA_DIR` to the restored directory and start the matching release.
5. Verify login, encrypted bank record access (masked by default), policy retrieval, and representative HR/payroll records before promoting the restore.
6. Keep the original backup untouched until the restore is validated.

## Final deployment gates

- Install dependencies and complete the production build.
- Configure HTTPS, trusted external URL, host firewall/reverse proxy and secure cookies.
- Configure sender-domain authentication and test actual SMTP accept, failure, retry and activation.
- Run regression tests and role-based end-to-end checks.
- Verify authorization boundaries, payroll cases and protected bank data.
- Complete an isolated backup/restore drill.
- Rotate any SMTP credentials previously included in developer ZIPs; never copy them into this package.
- Review the remaining known gaps in `IMPLEMENTATION_AUDIT.md` with the business owner.
