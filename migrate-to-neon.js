"use strict";
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const db = require("./config/database");

// Tables in dependency order so foreign keys don't fail
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

async function migrate() {
  console.log("=== MACROW HRMS: SQLite to Neon PostgreSQL Migration ===");
  const backupDbPath = path.resolve(__dirname, "backups", "original-macrow.db");
  if (!fs.existsSync(backupDbPath)) {
    throw new Error(`Backup database not found at ${backupDbPath}`);
  }

  const sqlite = new DatabaseSync(backupDbPath);
  console.log("Opened SQLite backup file:", backupDbPath);

  console.log("Creating PostgreSQL schema on Neon...");
  await db.initSchema();
  console.log("PostgreSQL schema successfully initialized on Neon.");

  // Disable triggers / constraints temporarily or insert in clean dependency order
  const countsReport = { sqlite: {}, postgres: {} };

  for (const tableName of TABLES_IN_ORDER) {
    const sqliteRows = sqlite.prepare(`SELECT * FROM "${tableName}"`).all();
    countsReport.sqlite[tableName] = sqliteRows.length;

    if (sqliteRows.length === 0) {
      countsReport.postgres[tableName] = 0;
      console.log(`- ${tableName}: 0 rows (skipped)`);
      continue;
    }

    console.log(`- Migrating ${tableName} (${sqliteRows.length} rows)...`);
    for (const row of sqliteRows) {
      const keys = Object.keys(row);
      const cols = keys.map(k => `"${k}"`).join(", ");
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
      const values = keys.map(k => row[k]);

      // Conflict target
      let conflictClause = "ON CONFLICT DO NOTHING";
      if (tableName === "users") {
        conflictClause = `ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name, role=EXCLUDED.role, password_hash=EXCLUDED.password_hash, active=EXCLUDED.active, company_id=EXCLUDED.company_id`;
      } else if (tableName === "companies") {
        conflictClause = `ON CONFLICT (id) DO NOTHING`;
      } else if (tableName === "employees") {
        conflictClause = `ON CONFLICT (user_id) DO UPDATE SET title=EXCLUDED.title, department=EXCLUDED.department, salary=EXCLUDED.salary, employee_code=EXCLUDED.employee_code`;
      } else if (tableName === "attendance") {
        conflictClause = `ON CONFLICT (user_id, work_date) DO NOTHING`;
      } else if (tableName === "payroll_periods") {
        conflictClause = `ON CONFLICT (period) DO NOTHING`;
      } else if (tableName === "payroll_items") {
        conflictClause = `ON CONFLICT (period_id, user_id) DO NOTHING`;
      } else if (tableName === "salary_structures") {
        conflictClause = `ON CONFLICT (user_id, effective_from) DO NOTHING`;
      } else if (tableName === "sessions") {
        conflictClause = `ON CONFLICT (token_hash) DO NOTHING`;
      } else if (tableName === "invites") {
        conflictClause = `ON CONFLICT (id) DO NOTHING`;
      } else if (tableName === "leave_categories") {
        conflictClause = `ON CONFLICT (id) DO NOTHING`;
      }

      const sql = `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) ${conflictClause}`;
      await db.pool.query(sql, values);
    }

    // Verify row count in Neon
    const pgCountRes = await db.pool.query(`SELECT count(*)::int as count FROM "${tableName}"`);
    countsReport.postgres[tableName] = pgCountRes.rows[0].count;
  }

  // Sync identity sequences if applicable
  await db.pool.query(`SELECT setval(pg_get_serial_sequence('login_attempts', 'id'), COALESCE((SELECT MAX(id) FROM login_attempts), 1));`);
  await db.pool.query(`SELECT setval(pg_get_serial_sequence('activation_attempts', 'id'), COALESCE((SELECT MAX(id) FROM activation_attempts), 1));`);

  console.log("\n=== Migration Summary & Row Count Comparison ===");
  let matchedAll = true;
  for (const t of TABLES_IN_ORDER) {
    const sq = countsReport.sqlite[t] || 0;
    const pg = countsReport.postgres[t] || 0;
    const status = sq === pg ? "MATCHED" : "MISMATCH";
    if (sq !== pg) matchedAll = false;
    if (sq > 0 || pg > 0) {
      console.log(`[${status}] ${t}: SQLite = ${sq}, Neon PG = ${pg}`);
    }
  }

  fs.writeFileSync(
    path.resolve(__dirname, "backups", "neon-migration-verification.json"),
    JSON.stringify(countsReport, null, 2)
  );

  if (matchedAll) {
    console.log("\n SUCCESS: All records safely migrated from SQLite to Neon PostgreSQL without loss!");
  } else {
    console.warn("\n WARNING: Some row counts did not match. Check details above.");
  }

  await db.pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
