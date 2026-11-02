"use strict";
const { Pool } = require("pg");
const fs = require("node:fs");
const path = require("node:path");

let dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  const envFile = path.resolve(__dirname, "..", ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key === "DATABASE_URL") {
          dbUrl = val;
          break;
        }
      }
    }
  }
}

if (!dbUrl) {
  console.warn("WARNING: DATABASE_URL is not set. Neon PostgreSQL will fail to connect.");
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client:", err.message);
});

/**
 * Transforms SQLite `?` placeholders into PostgreSQL `$1`, `$2`, etc.
 */
function convertPlaceholders(sql) {
  let paramIndex = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let result = "";

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      result += ch;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += ch;
    } else if (ch === "?" && !inSingleQuote && !inDoubleQuote) {
      result += "$" + paramIndex++;
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Normalizes SQL dialect differences between SQLite and PostgreSQL:
 * 1. datetime(expires_at, '-7 days') -> expires_at::timestamp - interval '7 days'
 * 2. AUTOINCREMENT -> Handled in schema (SERIAL)
 */
function normalizeSql(sql) {
  let s = sql;
  // Replace datetime(col, '-7 days')
  s = s.replace(/datetime\s*\(\s*([^,]+)\s*,\s*['-]([0-9]+)\s+days?'\s*\)/gi, "($1::timestamp - interval '$2 days')");
  s = s.replace(/datetime\s*\(\s*([^,]+)\s*,\s*['\+]([0-9]+)\s+days?'\s*\)/gi, "($1::timestamp + interval '$2 days')");
  return s;
}

/**
 * Execute query and return the first row (equivalent to SQLite `db.prepare().get()`)
 */
async function q(sql, ...params) {
  const norm = normalizeSql(sql);
  const pgSql = convertPlaceholders(norm);
  const res = await pool.query(pgSql, params.flat());
  return res.rows[0] || null;
}

/**
 * Execute query and return all matching rows (equivalent to SQLite `db.prepare().all()`)
 */
async function all(sql, ...params) {
  const norm = normalizeSql(sql);
  const pgSql = convertPlaceholders(norm);
  const res = await pool.query(pgSql, params.flat());
  return res.rows;
}

/**
 * Execute query without expecting rows (equivalent to SQLite `db.prepare().run()`)
 */
async function run(sql, ...params) {
  const norm = normalizeSql(sql);
  const pgSql = convertPlaceholders(norm);
  const res = await pool.query(pgSql, params.flat());
  return { changes: res.rowCount };
}

/**
 * Execute multiple raw SQL statements or DDL
 */
async function exec(sql) {
  return await pool.query(sql);
}

/**
 * Execute within a managed database transaction
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = {
      q: async (sql, ...params) => {
        const norm = normalizeSql(sql);
        const pgSql = convertPlaceholders(norm);
        const res = await client.query(pgSql, params.flat());
        return res.rows[0] || null;
      },
      all: async (sql, ...params) => {
        const norm = normalizeSql(sql);
        const pgSql = convertPlaceholders(norm);
        const res = await client.query(pgSql, params.flat());
        return res.rows;
      },
      run: async (sql, ...params) => {
        const norm = normalizeSql(sql);
        const pgSql = convertPlaceholders(norm);
        const res = await client.query(pgSql, params.flat());
        return { changes: res.rowCount };
      },
    };
    const result = await callback(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Initialize PostgreSQL Schema on Neon
 */
async function initSchema() {
  const schemaSql = require("./schema");
  await pool.query(schemaSql);
}

module.exports = {
  pool,
  q,
  all,
  run,
  exec,
  withTransaction,
  initSchema,
  convertPlaceholders,
  normalizeSql,
};

