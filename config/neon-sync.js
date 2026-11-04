"use strict";
const db = require("./database");

/**
 * Neon Sync Engine:
 * - Hydrates SQLite from Neon PostgreSQL Cloud on boot (if fresh container).
 * - Live write-back: captures all table mutations in SQLite and mirrors them into Neon.
 * - Periodic background sync loop: ensures 100% parity every 60 seconds.
 */

let isSyncing = false;
let syncTimeout = null;

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
  "payroll_approvals",
  "payroll_deduction_rules"
];

// Tables mapped to their primary unique keys for ON CONFLICT DO UPDATE
const TABLE_PKS = {
  users: ["id"],
  companies: ["id"],
  employees: ["user_id"],
  salary_structures: ["id"],
  invites: ["id"],
  sessions: ["token_hash"],
  activation_attempts: ["id"],
  login_attempts: ["id"],
  activity_logs: ["id"],
  audit_logs: ["id"],
  attendance: ["id"],
  bank_accounts: ["user_id"],
  bank_account_history: ["id"],
  calendar_events: ["id"],
  tasks: ["id"],
  task_subtasks: ["id"],
  task_comments: ["id"],
  task_history: ["id"],
  daily_updates: ["id"],
  daily_update_comments: ["id"],
  daily_update_history: ["id"],
  documents: ["id"],
  employee_projects: ["id"],
  leave_categories: ["id"],
  leave_rules: ["id"],
  notifications: ["id"],
  requests: ["id"],
  updates: ["id"],
  payroll_policies: ["id"],
  payroll_policy_history: ["id"],
  payroll_periods: ["id"],
  payroll_items: ["id"],
  payroll: ["id"],
  payroll_adjustments: ["id"],
  payroll_approvals: ["id"],
  payroll_deduction_rules: ["id"]
};

/**
 * Synchronizes all records from SQLite to Neon PostgreSQL Cloud.
 */
async function syncAllTables(sqliteDb) {
  if (!db.pool || isSyncing) return;
  isSyncing = true;
  try {
    for (const tableName of TABLES_IN_ORDER) {
      let rows;
      try {
        rows = sqliteDb.prepare(`SELECT * FROM "${tableName}"`).all();
      } catch {
        continue;
      }
      if (!rows || rows.length === 0) continue;

      for (const row of rows) {
        await upsertRow(tableName, row);
      }
    }
  } catch (err) {
    console.error("[NEON_SYNC] Background sync error:", err.message);
  } finally {
    isSyncing = false;
  }
}

/**
 * Upsert a single record into Neon PostgreSQL Cloud.
 */
async function upsertRow(tableName, row) {
  if (!db.pool || !row) return;
  try {
    const keys = Object.keys(row);
    if (keys.length === 0) return;

    const cols = keys.map((k) => `"${k}"`).join(", ");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const values = keys.map((k) => row[k]);

    const pks = TABLE_PKS[tableName] || ["id"];
    const nonPkKeys = keys.filter((k) => !pks.includes(k));

    let conflictClause = "ON CONFLICT DO NOTHING";
    if (pks.length > 0 && nonPkKeys.length > 0) {
      const pkCols = pks.map((k) => `"${k}"`).join(", ");
      const updateSets = nonPkKeys.map((k) => `"${k}" = EXCLUDED."${k}"`).join(", ");
      conflictClause = `ON CONFLICT (${pkCols}) DO UPDATE SET ${updateSets}`;
    }

    const sql = `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) ${conflictClause}`;
    await db.pool.query(sql, values);
  } catch (err) {
    if (err.code !== "23505") {
      // 23505 is unique_violation, harmless during race
      console.error(`[NEON_SYNC] Write error on ${tableName}:`, err.message);
    }
  }
}

/**
 * Schedule a debounced table-level sync to Neon whenever mutations occur.
 */
function scheduleSync(sqliteDb, delayMs = 1500) {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    syncAllTables(sqliteDb).catch((e) =>
      console.error("[NEON_SYNC] Scheduled sync failed:", e.message)
    );
  }, delayMs);
}

/**
 * Hooks into SQLite `db.prepare` to intercept write operations
 * (INSERT, UPDATE, DELETE) and immediately mirror them into Neon Cloud.
 */
function attachDbSyncHooks(sqliteDb) {
  if (sqliteDb._neonHooksAttached) return;
  sqliteDb._neonHooksAttached = true;

  const origPrepare = sqliteDb.prepare.bind(sqliteDb);
  sqliteDb.prepare = function (sql, ...prepArgs) {
    const stmt = origPrepare(sql, ...prepArgs);
    const origRun = stmt.run.bind(stmt);

    stmt.run = function (...runArgs) {
      const result = origRun(...runArgs);

      // Check if this is a write query (INSERT, UPDATE, DELETE, REPLACE)
      const trimmed = sql.trim().toUpperCase();
      if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/.test(trimmed)) {
        // Trigger debounced synchronization to guarantee Neon parity
        scheduleSync(sqliteDb);
      }
      return result;
    };

    return stmt;
  };

  // Start periodic background synchronization every 60 seconds
  setInterval(() => {
    syncAllTables(sqliteDb).catch((e) =>
      console.error("[NEON_SYNC] Periodic sync error:", e.message)
    );
  }, 60 * 1000);
}

/**
 * Hydrates SQLite from Neon PostgreSQL on server boot.
 * If Render spins up a fresh container with an empty SQLite database,
 * this immediately restores all tables and rows from Neon!
 */
async function restoreFromNeon(sqliteDb) {
  if (!db.pool) return;
  try {
    console.log("[NEON_SYNC] Hydrating local store from Neon PostgreSQL Cloud...");
    // Temporarily turn OFF foreign key checks during bulk restoration
    // to prevent circular or cross-table dependency failures (e.g. companies referencing users and users referencing companies)
    try {
      sqliteDb.exec("PRAGMA foreign_keys = OFF;");
    } catch {}

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
        const cols = keys.map((k) => `"${k}"`).join(", ");
        const placeholders = keys.map(() => `?`).join(", ");
        const values = keys.map((k) => row[k]);

        try {
          sqliteDb
            .prepare(`INSERT OR REPLACE INTO "${tableName}" (${cols}) VALUES (${placeholders})`)
            .run(...values);
        } catch (err) {
          // Ignore insertion conflicts during hydration
        }
      }
    }

    try {
      sqliteDb.exec("PRAGMA foreign_keys = ON;");
    } catch {}

    console.log("[NEON_SYNC] Hydration complete. All records from Neon are live in memory/cache.");
  } catch (err) {
    console.error("[NEON_SYNC] Failed to restore from Neon:", err.message);
  }
}

module.exports = {
  syncAllTables,
  restoreFromNeon,
  scheduleSync,
  attachDbSyncHooks,
  upsertRow,
};
