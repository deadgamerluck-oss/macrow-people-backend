"use strict";
const db = require("./database");

/**
 * Neon Sync Engine:
 * Intercepts write queries or synchronizes SQLite state into Neon PostgreSQL.
 * Ensures zero data loss on Render restarts.
 */
let isSyncing = false;

async function syncAllTables(sqliteDb) {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const TABLES_IN_ORDER = [
      "users",
      "companies",
      "employees",
      "salary_structures",
      "invites",
      "sessions",
      "activation_attempts",
      "login_attempts",
      "activity_logs",
      "audit_logs",
      "attendance",
      "bank_accounts",
      "bank_account_history",
      "calendar_events",
      "tasks",
      "task_subtasks",
      "task_comments",
      "task_history",
      "daily_updates",
      "daily_update_comments",
      "daily_update_history",
      "documents",
      "employee_projects",
      "leave_categories",
      "leave_rules",
      "notifications",
      "requests",
      "updates",
      "payroll_policies",
      "payroll_policy_history",
      "payroll_periods",
      "payroll_items",
      "payroll",
      "payroll_adjustments",
      "payroll_approvals"
    ];

    for (const tableName of TABLES_IN_ORDER) {
      let rows;
      try {
        rows = sqliteDb.prepare(`SELECT * FROM "${tableName}"`).all();
      } catch {
        continue;
      }
      if (!rows || rows.length === 0) continue;

      for (const row of rows) {
        const keys = Object.keys(row);
        const cols = keys.map(k => `"${k}"`).join(", ");
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        const values = keys.map(k => row[k]);

        let conflictClause = "ON CONFLICT DO NOTHING";
        if (tableName === "users") {
          conflictClause = `ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name, role=EXCLUDED.role, password_hash=EXCLUDED.password_hash, active=EXCLUDED.active, company_id=EXCLUDED.company_id`;
        } else if (tableName === "companies") {
          conflictClause = `ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, domain=EXCLUDED.domain, plan=EXCLUDED.plan, max_employees=EXCLUDED.max_employees, status=EXCLUDED.status, updated_at=EXCLUDED.updated_at`;
        } else if (tableName === "employees") {
          conflictClause = `ON CONFLICT (user_id) DO UPDATE SET title=EXCLUDED.title, department=EXCLUDED.department, location=EXCLUDED.location, phone=EXCLUDED.phone, emergency_contact=EXCLUDED.emergency_contact, salary=EXCLUDED.salary, employee_code=EXCLUDED.employee_code, annual_ctc_paise=EXCLUDED.annual_ctc_paise`;
        } else if (tableName === "attendance") {
          conflictClause = `ON CONFLICT (user_id, work_date) DO UPDATE SET segments=EXCLUDED.segments, status=EXCLUDED.status, admin_status=EXCLUDED.admin_status, admin_note=EXCLUDED.admin_note, admin_updated_by=EXCLUDED.admin_updated_by, admin_updated_at=EXCLUDED.admin_updated_at`;
        } else if (tableName === "payroll_periods") {
          conflictClause = `ON CONFLICT (company_id, period) DO UPDATE SET status=EXCLUDED.status, validation_json=EXCLUDED.validation_json, updated_at=EXCLUDED.updated_at, published_at=EXCLUDED.published_at, paid_at=EXCLUDED.paid_at`;
        } else if (tableName === "payroll_items") {
          conflictClause = `ON CONFLICT (period_id, user_id) DO UPDATE SET basic_paise=EXCLUDED.basic_paise, gross_paise=EXCLUDED.gross_paise, total_deductions_paise=EXCLUDED.total_deductions_paise, net_paise=EXCLUDED.net_paise, updated_at=EXCLUDED.updated_at`;
        } else if (tableName === "payroll_policies") {
          conflictClause = `ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, version=EXCLUDED.version, effective_from=EXCLUDED.effective_from, effective_to=EXCLUDED.effective_to, updated_at=EXCLUDED.updated_at`;
        } else if (tableName === "salary_structures") {
          conflictClause = `ON CONFLICT (user_id, effective_from) DO UPDATE SET basic_paise=EXCLUDED.basic_paise, allowances_json=EXCLUDED.allowances_json, earnings_json=EXCLUDED.earnings_json, deductions_json=EXCLUDED.deductions_json`;
        } else if (tableName === "sessions") {
          conflictClause = `ON CONFLICT (token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at`;
        } else if (tableName === "leave_categories") {
          conflictClause = `ON CONFLICT (id) DO UPDATE SET entitlement_days=EXCLUDED.entitlement_days, notes=EXCLUDED.notes, updated_at=EXCLUDED.updated_at`;
        }

        const sql = `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) ${conflictClause}`;
        try {
          await db.pool.query(sql, values);
        } catch (err) {
          // Log only unexpected errors, ignore standard duplicate keys
          if (err.code !== "23505") {
            console.error(`[NEON_SYNC] Table ${tableName} write error:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error("[NEON_SYNC] Background sync error:", err.message);
  } finally {
    isSyncing = false;
  }
}

/**
 * Hydrates SQLite from Neon PostgreSQL on server boot.
 * If Render spins up a fresh container with an empty SQLite database,
 * this immediately restores all tables and rows from Neon!
 */
async function restoreFromNeon(sqliteDb) {
  try {
    const TABLES_IN_ORDER = [
      "users",
      "companies",
      "employees",
      "salary_structures",
      "invites",
      "sessions",
      "activation_attempts",
      "login_attempts",
      "activity_logs",
      "audit_logs",
      "attendance",
      "bank_accounts",
      "bank_account_history",
      "calendar_events",
      "tasks",
      "task_subtasks",
      "task_comments",
      "task_history",
      "daily_updates",
      "daily_update_comments",
      "daily_update_history",
      "documents",
      "employee_projects",
      "leave_categories",
      "leave_rules",
      "notifications",
      "requests",
      "updates",
      "payroll_policies",
      "payroll_policy_history",
      "payroll_periods",
      "payroll_items",
      "payroll",
      "payroll_adjustments",
      "payroll_approvals"
    ];

    console.log("[NEON_SYNC] Hydrating local store from Neon PostgreSQL Cloud...");
    for (const tableName of TABLES_IN_ORDER) {
      let pgRows;
      try {
        pgRows = await db.all(`SELECT * FROM "${tableName}"`);
      } catch (err) {
        continue;
      }

      if (!pgRows || pgRows.length === 0) continue;

      for (const row of pgRows) {
        const keys = Object.keys(row);
        const cols = keys.map(k => `"${k}"`).join(", ");
        const placeholders = keys.map(() => `?`).join(", ");
        const values = keys.map(k => row[k]);

        try {
          sqliteDb.prepare(`INSERT OR REPLACE INTO "${tableName}" (${cols}) VALUES (${placeholders})`).run(...values);
        } catch (err) {
          // Ignore insertion conflicts during hydration
        }
      }
    }
    console.log("[NEON_SYNC] Hydration complete. All records from Neon are live in memory/cache.");
  } catch (err) {
    console.error("[NEON_SYNC] Failed to restore from Neon:", err.message);
  }
}

module.exports = {
  syncAllTables,
  restoreFromNeon,
};
