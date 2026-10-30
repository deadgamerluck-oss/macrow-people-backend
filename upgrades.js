"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SUPER_ADMIN = "super_admin",
  ADMIN = "admin",
  HR = "hr_manager",
  PAYROLL = "payroll_manager",
  MANAGER = "manager",
  EMPLOYEE = "employee";
const PAYROLL_ROLES = [SUPER_ADMIN, ADMIN, PAYROLL],
  HR_ROLES = [SUPER_ADMIN, ADMIN, HR],
  TASK_ROLES = [SUPER_ADMIN, ADMIN, HR, MANAGER];
let db, dataDir, encryptionKey;
const id = () => crypto.randomUUID();
const clean = (x, n = 5000) =>
  typeof x === "string" ? x.trim().slice(0, n) : "";
const now = () => new Date().toISOString();
const q = (sql, ...args) => db.prepare(sql).get(...args),
  all = (sql, ...args) => db.prepare(sql).all(...args),
  run = (sql, ...args) => db.prepare(sql).run(...args);
const parse = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
function safeImageData(value) {
  if (!value) return "";
  if (typeof value !== "string" || value.length > 2_000_000)
    fail(413, "Images must be 1.5 MB or smaller.");
  const m = value.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!m) fail(400, "Choose a PNG, JPEG, or WebP image.");
  const b = Buffer.from(m[2], "base64");
  if (!b.length || b.length > 1_500_000 || b.toString("base64") !== m[2])
    fail(413, "Images must be 1.5 MB or smaller.");
  const png = b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
    jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    webp =
      b.subarray(0, 4).toString() === "RIFF" &&
      b.subarray(8, 12).toString() === "WEBP";
  if (
    !(
      (m[1] === "image/png" && png) ||
      (m[1] === "image/jpeg" && jpg) ||
      (m[1] === "image/webp" && webp)
    )
  )
    fail(400, "Image contents do not match the file type.");
  return value;
}
function validDocx(buffer) {
  if (buffer.length < 22) return false;
  const minimum = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minimum; i--)
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  if (eocd < 0) return false;
  const entries = buffer.readUInt16LE(eocd + 10),
    central = buffer.readUInt32LE(eocd + 16);
  if (!entries || central >= buffer.length) return false;
  let cursor = central;
  const names = new Set();
  for (let i = 0; i < entries; i++) {
    if (
      cursor + 46 > buffer.length ||
      buffer.readUInt32LE(cursor) !== 0x02014b50
    )
      return false;
    const nameLength = buffer.readUInt16LE(cursor + 28),
      extraLength = buffer.readUInt16LE(cursor + 30),
      commentLength = buffer.readUInt16LE(cursor + 32);
    if (cursor + 46 + nameLength + extraLength + commentLength > buffer.length)
      return false;
    names.add(buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names.has("[Content_Types].xml") && names.has("word/document.xml");
}
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 256)
    fail(400, "Password must be at least 8 characters.");
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$32768$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
}
const isRole = (user, roles) => roles.includes(user.role);
function requireRole(user, roles, json, res) {
  if (isRole(user, roles)) return true;
  json(res, 403, { error: "You do not have permission for this action." });
  return false;
}
function sameCompany(user, targetUserId) {
  if (user?.role === SUPER_ADMIN) return true;
  const target = q("SELECT company_id FROM users WHERE id=?", targetUserId);
  return !!target && String(target.company_id || "") === String(user?.company_id || "");
}
function requireCompanyUser(user, targetUserId, json, res) {
  if (sameCompany(user, targetUserId)) return true;
  json(res, 404, { error: "Record not found." });
  return false;
}
function companyWhere(user, alias = "u") {
  return user?.role === SUPER_ADMIN ? { sql: "1=1", args: [] } : {
    sql: `COALESCE(${alias}.company_id,'')=?`, args: [String(user?.company_id || "")],
  };
}
function audit(actor, action, entity, entityId = "", details = "") {
  run(
    "INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?)",
    id(),
    actor,
    action,
    entity,
    String(entityId),
    clean(details, 1000),
    now(),
  );
}
function notify(userId, title, body, kind = "info", entityId = "") {
  if (!userId) return;
  run(
    "INSERT INTO notifications(id,user_id,title,body,kind,entity_id,created_at,read_at) VALUES(?,?,?,?,?,?,?,NULL)",
    id(),
    userId,
    clean(title, 180),
    clean(body, 1500),
    kind,
    String(entityId),
    now(),
  );
}
function notifyRole(role, title, body, kind = "info", entityId = "", companyId = "") {
  for (const row of all("SELECT id FROM users WHERE role=? AND active=1 AND COALESCE(company_id,'')=?", role, companyId || ""))
    notify(row.id, title, body, kind, entityId);
}
function ensureColumn(table, name, declaration) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === name))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
}
function initUpgrades(database, folder) {
  db = database;
  dataDir = folder;
  const userSql =
    q("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
      ?.sql || "";
  if (!userSql.includes("super_admin") || !userSql.includes("payroll_manager")) {
    db.exec(
      "PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; CREATE TABLE users_upgrade(id TEXT PRIMARY KEY,company_id TEXT,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('super_admin','admin','hr_manager','payroll_manager','manager','employee')),password_hash TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL); INSERT INTO users_upgrade(id,email,name,role,password_hash,active,created_at) SELECT id,email,name,role,password_hash,active,created_at FROM users; DROP TABLE users; ALTER TABLE users_upgrade RENAME TO users; COMMIT; PRAGMA foreign_keys=ON;",
    );
  }
  ensureColumn("users", "company_id", "TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS companies(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    plan TEXT NOT NULL DEFAULT 'Standard',
    max_employees INTEGER NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Suspended','Archived')),
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  ensureColumn("employees", "employee_code", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "exit_date", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "address", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "date_of_birth", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "responsibilities", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "skills_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("employees", "manager_id", "TEXT REFERENCES users(id)");
  ensureColumn("employees", "profile_updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "avatar_data", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "bio", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "pronouns", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "linkedin_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "website_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("employees", "interests", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    "employees",
    "certifications_json",
    "TEXT NOT NULL DEFAULT '[]'",
  );
  ensureColumn("employees", "annual_ctc_paise", "INTEGER NOT NULL DEFAULT 0");
  db.exec(
    "CREATE TABLE IF NOT EXISTS updates(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,audience TEXT NOT NULL DEFAULT 'all',pinned INTEGER NOT NULL DEFAULT 0,author_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL)",
  );
  ensureColumn("updates", "company_id", "TEXT NOT NULL DEFAULT ''");
  run("UPDATE updates SET company_id=COALESCE((SELECT company_id FROM users WHERE id=author_id),'') WHERE company_id='' OR company_id IS NULL");
  ensureColumn("updates", "image_data", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("invites", "role", "TEXT NOT NULL DEFAULT 'employee'");
  ensureColumn("invites", "created_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("invites", "sent_at", "TEXT");
  ensureColumn("invites", "email_status", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn("invites", "correlation_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("invites", "smtp_message_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("invites", "company_id", "TEXT NOT NULL DEFAULT ''");
  run("UPDATE invites SET company_id=COALESCE((SELECT company_id FROM users WHERE id=created_by),'') WHERE company_id='' OR company_id IS NULL");
  const existingCodes = new Set(
    all("SELECT employee_code FROM employees WHERE employee_code<>''").map(
      (x) => String(x.employee_code).toUpperCase(),
    ),
  );
  let employeeSequence = all("SELECT employee_code FROM employees").reduce(
    (max, row) => {
      const match = String(row.employee_code || "").match(/^MAC-EMP-(\d+)$/i);
      return match ? Math.max(max, Number(match[1])) : max;
    },
    0,
  );
  for (const row of all(
    "SELECT e.user_id FROM employees e JOIN users u ON u.id=e.user_id WHERE u.role<>'admin' AND COALESCE(e.employee_code,'')='' ORDER BY u.created_at,u.id",
  )) {
    let code;
    do {
      employeeSequence++;
      code = `MAC-EMP-${String(employeeSequence).padStart(4, "0")}`;
    } while (existingCodes.has(code));
    run(
      "UPDATE employees SET employee_code=? WHERE user_id=?",
      code,
      row.user_id,
    );
    existingCodes.add(code);
  }
  if (
    !all(
      "SELECT employee_code FROM employees WHERE employee_code<>'' GROUP BY employee_code COLLATE NOCASE HAVING count(*)>1 LIMIT 1",
    ).length
  )
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_employee_code ON employees(employee_code COLLATE NOCASE) WHERE employee_code<>''",
    );
  db.exec(
    "CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,category TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',published INTEGER NOT NULL DEFAULT 1,author_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL)",
  );
  ensureColumn("documents", "company_id", "TEXT NOT NULL DEFAULT ''");
  run("UPDATE documents SET company_id=COALESCE((SELECT company_id FROM users WHERE id=author_id),'') WHERE company_id='' OR company_id IS NULL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS activation_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,token_hash TEXT NOT NULL,ip TEXT NOT NULL,success INTEGER NOT NULL,created_at TEXT NOT NULL); UPDATE invites SET created_at=datetime(expires_at,'-7 days') WHERE created_at=''; UPDATE invites SET email_status='sent' WHERE used_at IS NOT NULL AND email_status='pending';",
  );
  for (const [name, sql] of Object.entries({
    description: "TEXT NOT NULL DEFAULT ''",
    original_filename: "TEXT NOT NULL DEFAULT ''",
    storage_key: "TEXT NOT NULL DEFAULT ''",
    mime_type: "TEXT NOT NULL DEFAULT ''",
    file_size: "INTEGER NOT NULL DEFAULT 0",
    version: "INTEGER NOT NULL DEFAULT 1",
    supersedes_id: "TEXT",
    updated_at: "TEXT NOT NULL DEFAULT ''",
  }))
    ensureColumn("documents", name, sql);
  ensureColumn("requests", "leave_type", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("requests", "payroll_leave_status", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("requests", "created_by", "TEXT REFERENCES users(id)");
  ensureColumn("requests", "manual_entry", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("calendar_events", "company_id", "TEXT NOT NULL DEFAULT ''");
  run("UPDATE calendar_events SET company_id=COALESCE((SELECT company_id FROM users WHERE id=created_by),'') WHERE company_id='' OR company_id IS NULL");
  for (const [name, sql] of Object.entries({
    description: "TEXT NOT NULL DEFAULT ''",
    priority: "TEXT NOT NULL DEFAULT 'Medium'",
    start_date: "TEXT NOT NULL DEFAULT ''",
    estimate_hours: "REAL NOT NULL DEFAULT 0",
    category: "TEXT NOT NULL DEFAULT ''",
    project: "TEXT NOT NULL DEFAULT ''",
    attachment_url: "TEXT NOT NULL DEFAULT ''",
    review_feedback: "TEXT NOT NULL DEFAULT ''",
    accepted_at: "TEXT",
    completed_at: "TEXT",
  }))
    ensureColumn("tasks", name, sql);
  ensureColumn("leave_rules", "is_paid", "INTEGER NOT NULL DEFAULT 1");
  db.exec(`CREATE TABLE IF NOT EXISTS leave_categories(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,category TEXT NOT NULL CHECK(category IN ('Paid','Unpaid')),entitlement_days REAL NOT NULL DEFAULT 0,allow_half_day INTEGER NOT NULL DEFAULT 1,exclude_non_working_days INTEGER NOT NULL DEFAULT 1,excess_to_unpaid INTEGER NOT NULL DEFAULT 1,notes TEXT NOT NULL DEFAULT '',updated_by TEXT REFERENCES users(id),updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS daily_updates(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),task_id TEXT REFERENCES tasks(id),work_date TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,project TEXT NOT NULL DEFAULT '',client TEXT NOT NULL DEFAULT '',priority TEXT NOT NULL DEFAULT 'Medium',status TEXT NOT NULL DEFAULT 'In Progress',progress INTEGER NOT NULL DEFAULT 0,completed_today TEXT NOT NULL DEFAULT '',pending_work TEXT NOT NULL DEFAULT '',blockers TEXT NOT NULL DEFAULT '',next_steps TEXT NOT NULL DEFAULT '',time_spent REAL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS daily_updates_user_date_idx ON daily_updates(user_id,work_date DESC,updated_at DESC);
  CREATE TABLE IF NOT EXISTS daily_update_history(id TEXT PRIMARY KEY,update_id TEXT NOT NULL REFERENCES daily_updates(id) ON DELETE CASCADE,actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS daily_update_comments(id TEXT PRIMARY KEY,update_id TEXT NOT NULL REFERENCES daily_updates(id) ON DELETE CASCADE,author_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bank_account_history(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,status TEXT NOT NULL,encrypted_snapshot TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS employee_projects(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),project TEXT NOT NULL,client TEXT NOT NULL DEFAULT '',responsibility TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'Active',start_date TEXT NOT NULL DEFAULT '',end_date TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS salary_structures(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),effective_from TEXT NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',basic_paise INTEGER NOT NULL,allowances_json TEXT NOT NULL DEFAULT '[]',earnings_json TEXT NOT NULL DEFAULT '[]',deductions_json TEXT NOT NULL DEFAULT '[]',workday_method TEXT NOT NULL DEFAULT 'working_days' CHECK(workday_method IN ('calendar_days','working_days')),weekly_offs_json TEXT NOT NULL DEFAULT '[0]',paid_leave_entitlement REAL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,UNIQUE(user_id,effective_from));
  CREATE INDEX IF NOT EXISTS salary_effective_idx ON salary_structures(user_id,effective_from DESC);
  CREATE TABLE IF NOT EXISTS payroll_periods(id TEXT PRIMARY KEY,company_id TEXT NOT NULL DEFAULT '',period TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Validation','HR Review','Payroll Approval','Finalized','Published','Paid')),calculation_method TEXT NOT NULL DEFAULT 'per_employee',validation_json TEXT NOT NULL DEFAULT '[]',created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,hr_reviewer TEXT REFERENCES users(id),payroll_approver TEXT REFERENCES users(id),finalized_by TEXT REFERENCES users(id),published_at TEXT,paid_at TEXT,payment_reference TEXT NOT NULL DEFAULT '',period_start_date TEXT NOT NULL DEFAULT '',period_end_date TEXT NOT NULL DEFAULT '',UNIQUE(company_id,period));
  CREATE TABLE IF NOT EXISTS payroll_items(id TEXT PRIMARY KEY,period_id TEXT NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),salary_structure_id TEXT NOT NULL REFERENCES salary_structures(id),calendar_days INTEGER NOT NULL,scheduled_days REAL NOT NULL,present_days REAL NOT NULL,paid_leave_days REAL NOT NULL,unpaid_leave_days REAL NOT NULL,payable_days REAL NOT NULL,basic_paise INTEGER NOT NULL,allowances_json TEXT NOT NULL,earnings_json TEXT NOT NULL,gross_paise INTEGER NOT NULL,leave_deduction_paise INTEGER NOT NULL,other_deductions_json TEXT NOT NULL,total_deductions_paise INTEGER NOT NULL,net_paise INTEGER NOT NULL,calculation_json TEXT NOT NULL,validation_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(period_id,user_id));
  CREATE TABLE IF NOT EXISTS payroll_approvals(id TEXT PRIMARY KEY,period_id TEXT NOT NULL REFERENCES payroll_periods(id),stage TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS payroll_adjustments(id TEXT PRIMARY KEY,payroll_item_id TEXT NOT NULL REFERENCES payroll_items(id),amount_paise INTEGER NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bank_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id),ciphertext TEXT NOT NULL,iv TEXT NOT NULL,tag TEXT NOT NULL,updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL);
  `);
  ensureColumn("payroll_periods", "company_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("payroll_periods", "period_start_date", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("payroll_periods", "period_end_date", "TEXT NOT NULL DEFAULT ''");
  run("UPDATE payroll_periods SET company_id=COALESCE((SELECT company_id FROM users WHERE id=created_by),'') WHERE company_id='' OR company_id IS NULL");
  const payrollTableSql = q("SELECT sql FROM sqlite_master WHERE type='table' AND name='payroll_periods'")?.sql || "";
  if (/period\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(payrollTableSql)) {
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
    try {
      db.exec(`CREATE TABLE payroll_periods_rebuilt(
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL DEFAULT '', period TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Validation','HR Review','Payroll Approval','Finalized','Published','Paid')),
        calculation_method TEXT NOT NULL DEFAULT 'per_employee', validation_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        hr_reviewer TEXT REFERENCES users(id), payroll_approver TEXT REFERENCES users(id), finalized_by TEXT REFERENCES users(id),
        published_at TEXT, paid_at TEXT, payment_reference TEXT NOT NULL DEFAULT '',
        period_start_date TEXT NOT NULL DEFAULT '', period_end_date TEXT NOT NULL DEFAULT '', UNIQUE(company_id,period)
      );
      INSERT INTO payroll_periods_rebuilt(id,company_id,period,status,calculation_method,validation_json,created_by,created_at,updated_at,hr_reviewer,payroll_approver,finalized_by,published_at,paid_at,payment_reference,period_start_date,period_end_date)
        SELECT id,COALESCE(company_id,''),period,status,calculation_method,validation_json,created_by,created_at,updated_at,hr_reviewer,payroll_approver,finalized_by,published_at,paid_at,payment_reference,period_start_date,period_end_date FROM payroll_periods;
      DROP TABLE payroll_periods;
      ALTER TABLE payroll_periods_rebuilt RENAME TO payroll_periods;
      CREATE INDEX IF NOT EXISTS payroll_period_status_idx ON payroll_periods(status,period);`);
      db.exec("COMMIT; PRAGMA foreign_keys=ON;");
    } catch (error) {
      db.exec("ROLLBACK; PRAGMA foreign_keys=ON;");
      throw error;
    }
  }
  // Earlier releases could place employees from more than one company in the same monthly run.
  // Split those legacy runs by employee company while retaining item/approval history.
  for (const oldPeriod of all("SELECT * FROM payroll_periods")) {
    const groups = all("SELECT COALESCE(u.company_id,'') AS company_id FROM payroll_items i JOIN users u ON u.id=i.user_id WHERE i.period_id=? GROUP BY COALESCE(u.company_id,'')", oldPeriod.id);
    if (groups.length <= 1) {
      if (groups.length === 1 && groups[0].company_id !== oldPeriod.company_id)
        run("UPDATE payroll_periods SET company_id=? WHERE id=?", groups[0].company_id, oldPeriod.id);
      continue;
    }
    const creatorCompany = q("SELECT COALESCE(company_id,'') AS company_id FROM users WHERE id=?", oldPeriod.created_by)?.company_id || "";
    const baseCompany = groups.some((x) => x.company_id === creatorCompany) ? creatorCompany : groups[0].company_id;
    run("UPDATE payroll_periods SET company_id=? WHERE id=?", baseCompany, oldPeriod.id);
    for (const group of groups.filter((x) => x.company_id !== baseCompany)) {
      const newPeriodId = id();
      run("INSERT INTO payroll_periods(id,company_id,period,status,calculation_method,validation_json,created_by,created_at,updated_at,hr_reviewer,payroll_approver,finalized_by,published_at,paid_at,payment_reference,period_start_date,period_end_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        newPeriodId, group.company_id, oldPeriod.period, oldPeriod.status, oldPeriod.calculation_method, oldPeriod.validation_json, oldPeriod.created_by, oldPeriod.created_at, oldPeriod.updated_at, oldPeriod.hr_reviewer, oldPeriod.payroll_approver, oldPeriod.finalized_by, oldPeriod.published_at, oldPeriod.paid_at, oldPeriod.payment_reference, oldPeriod.period_start_date, oldPeriod.period_end_date);
      run("UPDATE payroll_items SET period_id=? WHERE period_id=? AND user_id IN (SELECT id FROM users WHERE COALESCE(company_id,'')=?)", newPeriodId, oldPeriod.id, group.company_id);
      for (const approval of all("SELECT * FROM payroll_approvals WHERE period_id=?", oldPeriod.id))
        run("INSERT INTO payroll_approvals(id,period_id,stage,actor_id,action,note,created_at) VALUES(?,?,?,?,?,?,?)", id(), newPeriodId, approval.stage, approval.actor_id, approval.action, approval.note, approval.created_at);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_deduction_rules(
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL DEFAULT '', employee_id TEXT REFERENCES users(id),
    name TEXT NOT NULL, calculation_method TEXT NOT NULL CHECK(calculation_method IN ('fixed','percentage')),
    amount_paise INTEGER NOT NULL DEFAULT 0, percentage REAL NOT NULL DEFAULT 0,
    percentage_basis TEXT NOT NULL DEFAULT 'gross' CHECK(percentage_basis IN ('gross','basic')),
    frequency TEXT NOT NULL DEFAULT 'monthly' CHECK(frequency IN ('monthly','one_time')), period TEXT NOT NULL DEFAULT '',
    effective_from TEXT NOT NULL, effective_to TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS payroll_deduction_rules_scope_idx ON payroll_deduction_rules(company_id,employee_id,active,effective_from);`);
  ensureColumn("payroll_deduction_rules", "frequency", "TEXT NOT NULL DEFAULT 'monthly'");
  ensureColumn("payroll_deduction_rules", "period", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    "leave_categories",
    "monthly_accrual_days",
    "REAL NOT NULL DEFAULT 0",
  );
  ensureColumn("attendance", "admin_status", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("attendance", "admin_note", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("attendance", "admin_updated_by", "TEXT REFERENCES users(id)");
  ensureColumn("attendance", "admin_updated_at", "TEXT");
  run(
    "UPDATE leave_categories SET monthly_accrual_days=1,entitlement_days=12 WHERE lower(name) IN ('pl','paid leave','privilege leave','privilege leaves') AND monthly_accrual_days=0",
  );
  ensureColumn(
    "bank_accounts",
    "status",
    "TEXT NOT NULL DEFAULT 'Pending Verification'",
  );
  ensureColumn("bank_accounts", "submitted_at", "TEXT");
  ensureColumn("bank_accounts", "verified_at", "TEXT");
  ensureColumn("bank_accounts", "verified_by", "TEXT REFERENCES users(id)");
  ensureColumn("bank_accounts", "review_note", "TEXT NOT NULL DEFAULT ''");
  db.exec(`
  CREATE TABLE IF NOT EXISTS task_subtasks(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Open',sort_order INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,completed_at TEXT);
  CREATE TABLE IF NOT EXISTS task_comments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS task_history(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,body TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'info',entity_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,read_at TEXT);
  CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS payroll_period_status_idx ON payroll_periods(status,period);`);
  if (!all("SELECT id FROM leave_categories LIMIT 1").length) {
    for (const old of all("SELECT * FROM leave_rules")) {
      const entitlement =
        Number(old.annual_days || 0) + Number(old.sick_days || 0);
      run(
        "INSERT OR IGNORE INTO leave_categories(id,name,category,entitlement_days,allow_half_day,exclude_non_working_days,excess_to_unpaid,notes,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        id(),
        old.name,
        old.is_paid ? "Paid" : "Unpaid",
        entitlement,
        1,
        1,
        1,
        old.notes || "",
        old.updated_at || now(),
      );
    }
  }
  if (
    !q(
      "SELECT id FROM leave_categories WHERE lower(name) IN ('pl','paid leave','privilege leave','privilege leaves')",
    )
  )
    run(
      "INSERT INTO leave_categories(id,name,category,entitlement_days,monthly_accrual_days,allow_half_day,exclude_non_working_days,excess_to_unpaid,notes,updated_at) VALUES(?,?,'Paid',12,1,1,1,1,?,?)",
      id(),
      "Privilege Leave",
      "Accrues 1 day per month; subject to Admin policy.",
      now(),
    );
  db.exec(`
  CREATE TABLE IF NOT EXISTS payroll_policies(
    id TEXT PRIMARY KEY,
    company_id TEXT,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Draft','Active','Inactive')),
    version INTEGER NOT NULL DEFAULT 1,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    salary_calculation_method TEXT NOT NULL DEFAULT 'calendar_days' CHECK(salary_calculation_method IN ('calendar_days','fixed_30','working_days','custom_divisor')),
    fixed_divisor INTEGER NOT NULL DEFAULT 30,
    custom_divisor INTEGER NOT NULL DEFAULT 30,
    weekly_off_days_json TEXT NOT NULL DEFAULT '[0,6]',
    weekly_offs_paid INTEGER NOT NULL DEFAULT 1,
    sandwich_weekly_offs INTEGER NOT NULL DEFAULT 0,
    weekly_offs_in_divisor INTEGER NOT NULL DEFAULT 1,
    holidays_paid INTEGER NOT NULL DEFAULT 1,
    sandwich_holidays INTEGER NOT NULL DEFAULT 0,
    proration_method TEXT NOT NULL DEFAULT 'calendar_days' CHECK(proration_method IN ('calendar_days','working_days')),
    leave_deduction_divisor_method TEXT NOT NULL DEFAULT 'calendar_days' CHECK(leave_deduction_divisor_method IN ('calendar_days','working_days','fixed_30')),
    unpaid_leave_enabled INTEGER NOT NULL DEFAULT 1,
    half_day_factor REAL NOT NULL DEFAULT 0.5,
    late_deduction_enabled INTEGER NOT NULL DEFAULT 0,
    late_grace_minutes INTEGER NOT NULL DEFAULT 15,
    late_penalty_paise INTEGER NOT NULL DEFAULT 0,
    shift_start_time TEXT NOT NULL DEFAULT '10:10',
    attendance_deduction_enabled INTEGER NOT NULL DEFAULT 0,
    custom_rules_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payroll_policy_history(
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS payroll_policies_eff_idx ON payroll_policies(status, effective_from DESC);
  `);
  ensureColumn("payroll_items", "policy_id", "TEXT");
  ensureColumn("payroll_items", "policy_version", "INTEGER");
  ensureColumn("payroll_policies", "shift_start_time", "TEXT NOT NULL DEFAULT '10:10'");

  if (!q("SELECT id FROM payroll_policies LIMIT 1")) {
    const defaultPid = id();
    run(
      `INSERT INTO payroll_policies(
        id, company_id, name, code, status, version, effective_from, effective_to,
        salary_calculation_method, fixed_divisor, custom_divisor, weekly_off_days_json,
        weekly_offs_paid, sandwich_weekly_offs, weekly_offs_in_divisor, holidays_paid,
        sandwich_holidays, proration_method, leave_deduction_divisor_method, unpaid_leave_enabled,
        half_day_factor, late_deduction_enabled, late_grace_minutes, late_penalty_paise,
        attendance_deduction_enabled, custom_rules_json, created_by, created_at, updated_at
      ) VALUES(
        ?, '', 'Standard Company Policy', 'POL-STD', 'Active', 1, '2020-01-01', NULL,
        'calendar_days', 30, 30, '[0,6]',
        1, 0, 1, 1,
        0, 'calendar_days', 'calendar_days', 1,
        0.5, 0, 15, 0,
        0, '[]', NULL, ?, ?
      )`,
      defaultPid,
      now(),
      now(),
    );
    run(
      "INSERT INTO payroll_policy_history(id, policy_id, version, snapshot_json, action, actor_id, created_at) VALUES(?,?,?,?,?,?,?)",
      id(),
      defaultPid,
      1,
      JSON.stringify(q("SELECT * FROM payroll_policies WHERE id=?", defaultPid)),
      "create",
      null,
      now(),
    );
  }

  const keyFromEnv = process.env.HRMS_ENCRYPTION_KEY;
  if (keyFromEnv) {
    const key = Buffer.from(keyFromEnv, "base64");
    if (key.length !== 32)
      throw new Error(
        "HRMS_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
      );
    encryptionKey = key;
  } else {
    const keyFile = path.join(dataDir, "hrms-encryption.key");
    if (fs.existsSync(keyFile)) encryptionKey = fs.readFileSync(keyFile);
    else {
      encryptionKey = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, encryptionKey, { mode: 0o600, flag: "wx" });
    }
    try {
      if (process.platform !== "win32") fs.chmodSync(keyFile, 0o600);
    } catch {}
  }
  autoPreparePreviousMonth();
  const payrollScheduler = setInterval(
    autoPreparePreviousMonth,
    6 * 60 * 60 * 1000,
  );
  payrollScheduler.unref?.();
}

function amountPaise(value, label = "Amount") {
  const text = String(value ?? "").trim(),
    m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m)
    fail(
      400,
      `${label} must be a non-negative INR amount with up to 2 decimal places.`,
    );
  const n = BigInt(m[1]) * 100n + BigInt((m[2] || "").padEnd(2, "0") || "0");
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail(400, `${label} is too large.`);
  return Number(n);
}
function components(value, label) {
  if (value == null || value === "") return [];
  let list = typeof value === "string" ? parse(value, []) : value;
  if (!Array.isArray(list))
    fail(400, `${label} must be a list of named components.`);
  return list
    .map((x) => ({
      name: clean(x.name, 100),
      amount_paise: amountPaise(x.amount, label),
    }))
    .filter((x) => x.name);
}
function cleanPeriod(value) {
  const p = clean(value, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p))
    fail(400, "Period must use YYYY-MM format.");
  return p;
}
function monthBounds(period) {
  const [year, month] = period.split("-").map(Number);
  return {
    start: `${period}-01`,
    end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
    days: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    year,
  };
}
function parseDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return null;
  const timestamp = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return new Date(timestamp).toISOString().slice(0, 10) === date ? timestamp : null;
}
function minutesInCompanyTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}
function makeDays(start, end) {
  const a = parseDate(start),
    b = parseDate(end);
  if (a === null || b === null || b < a) return [];
  const days = [];
  for (let t = a; t <= b; t += 86400000)
    days.push({
      date: new Date(t).toISOString().slice(0, 10),
      weekday: new Date(t).getUTCDay(),
    });
  return days;
}
function weeksFor(structure) {
  const a = parse(structure?.weekly_offs_json, null);
  return new Set(Array.isArray(a) ? a.map(Number) : [0, 6]);
}
function fetchHolidays(start, end, companyId = "") {
  return all(
    "SELECT start_date,end_date,title FROM calendar_events WHERE kind='holiday' AND approved=1 AND COALESCE(company_id,'')=? AND start_date<=? AND COALESCE(end_date,start_date)>=?",
    companyId || "",
    end,
    start,
  );
}
function workdays(start, end, weeklyOffs, holidays) {
  const holidayDates = new Set();
  for (const h of holidays)
    for (const d of makeDays(h.start_date, h.end_date || h.start_date))
      holidayDates.add(d.date);
  return makeDays(start, end)
    .filter((d) => !weeklyOffs.has(d.weekday) && !holidayDates.has(d.date))
    .map((d) => d.date);
}
function requestType(row) {
  if (row.leave_type) return row.leave_type;
  const m = /^([^:]{1,100}):/.exec(row.details || "");
  return m ? m[1].trim() : "";
}
function leaveOffs(weeklyOffs) {
  return new Set(weeklyOffs);
}
function leaveUnits(row, weeklyOffs, holidays, excludeNonWorking = true) {
  return leaveDayUnits(row, weeklyOffs, holidays).reduce((sum, item) => sum + item.units, 0);
}
function leaveDayUnits(row, weeklyOffs, holidays) {
  const from = row.start_date || row.created_at?.slice(0, 10),
    to = row.end_date || from;
  if (!from || !to) return [];
  const days = workdays(from, to, leaveOffs(weeklyOffs), holidays);
  const requested = Number(row.days);
  let remaining = Number.isFinite(requested) && requested > 0
    ? Math.min(days.length, requested)
    : days.length;
  const selected = [];
  for (const date of days) {
    if (remaining <= 0) break;
    const units = Math.min(1, remaining);
    selected.push({ date, units });
    remaining -= units;
  }
  return selected;
}
function approvedLeaveRows(userId, year) {
  return all(
    "SELECT * FROM requests WHERE user_id=? AND kind='Leave' AND status='Approved' AND COALESCE(end_date,start_date)>=? AND start_date<=? ORDER BY start_date,created_at",
    userId,
    `${year}-01-01`,
    `${year}-12-31`,
  );
}
function getActivePolicy(period, companyId = "") {
  const periodEnd = monthBounds(period).end;
  let policy = null;
  if (companyId) {
    policy = q(
      "SELECT * FROM payroll_policies WHERE status='Active' AND company_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC LIMIT 1",
      companyId,
      periodEnd,
      `${period}-01`,
    );
  }
  if (!policy) {
    policy = q(
      "SELECT * FROM payroll_policies WHERE status='Active' AND (company_id='' OR company_id IS NULL) AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC LIMIT 1",
      periodEnd,
      `${period}-01`,
    );
  }
  if (!policy) {
    policy = q("SELECT * FROM payroll_policies ORDER BY (status='Active') DESC, effective_from DESC LIMIT 1");
  }
  return policy;
}

function calculateEmployee(user, employee, structure, period, allCategories, customPolicy = null, periodRange = null) {
  const month = monthBounds(period);
  const rangeStart = periodRange?.start_date || month.start;
  const rangeEnd = periodRange?.end_date || month.end;
  if (!parseDate(rangeStart) || !parseDate(rangeEnd) || rangeStart > rangeEnd || rangeStart < month.start || rangeEnd > month.end)
    fail(400, "Payroll date range must be valid and within the selected month.");
  const bounds = { ...month, calendar_start: month.start, calendar_end: month.end, start: rangeStart, end: rangeEnd };
  const ruleCompany = employee?.company_id || user?.company_id || "";
  const policy = customPolicy || getActivePolicy(period, employee?.company_id || user?.company_id || "") || {
    id: "default",
    name: "Standard Company Policy",
    version: 1,
    salary_calculation_method: structure?.workday_method === "calendar_days" ? "calendar_days" : "working_days",
    fixed_divisor: 30,
    custom_divisor: 30,
    weekly_off_days_json: structure?.weekly_offs_json || "[0,6]",
    weekly_offs_paid: 1,
    sandwich_weekly_offs: 0,
    weekly_offs_in_divisor: 1,
    holidays_paid: 1,
    sandwich_holidays: 0,
    proration_method: structure?.workday_method === "calendar_days" ? "calendar_days" : "working_days",
    leave_deduction_divisor_method: structure?.workday_method === "calendar_days" ? "calendar_days" : "working_days",
    unpaid_leave_enabled: 1,
    half_day_factor: 0.5,
    late_deduction_enabled: 0,
    late_grace_minutes: 15,
    late_penalty_paise: 0,
    shift_start_time: "10:10",
    attendance_deduction_enabled: 0,
    custom_rules_json: "[]",
  };

  const parsedPolicyWeeks = parse(policy.weekly_off_days_json, null);
  const parsedStructureWeeks = structure?.weekly_offs_json
    ? parse(structure.weekly_offs_json, null)
    : null;
  const parsedWeeklyOffs = Array.isArray(parsedPolicyWeeks)
    ? parsedPolicyWeeks
    : parsedStructureWeeks;
  const weeklyOffs = new Set(
    Array.isArray(parsedWeeklyOffs)
      ? parsedWeeklyOffs.map(Number)
      : [0, 6],
  );
  const holidayRows = fetchHolidays(bounds.calendar_start, bounds.calendar_end, ruleCompany);
  const holidayDates = new Set();
  for (const h of holidayRows) {
    for (const d of makeDays(h.start_date, h.end_date || h.start_date)) {
      holidayDates.add(d.date);
    }
  }

  const allMonthDays = makeDays(bounds.calendar_start, bounds.calendar_end);
  const scheduled = allMonthDays
    .filter((d) => !weeklyOffs.has(d.weekday) && !holidayDates.has(d.date))
    .map((d) => d.date);
  const validation = [];

  const startDate = employee.start_date || bounds.start,
    exitDate = employee.exit_date || bounds.end,
    effective = structure.effective_from || bounds.start;
  const activeStart = [bounds.start, startDate, effective].sort().at(-1),
    activeEnd = [bounds.end, exitDate].sort()[0];

  const activeDaysList = makeDays(activeStart, activeEnd);
  if (!activeDaysList.length) validation.push({
    level: "error", code: "no_employment_days",
    message: "Employee has no eligible employment dates within this payroll range.",
  });
  const scheduledActiveDates = activeDaysList
    .filter((d) => !weeklyOffs.has(d.weekday) && !holidayDates.has(d.date))
    .map((d) => d.date);
  const scheduledActive = scheduledActiveDates.length;
  const scheduledSet = new Set(scheduledActiveDates);
  const paidActiveCalendarDays = activeDaysList.filter((day) => {
    const weeklyOff = weeklyOffs.has(day.weekday);
    const companyHoliday = holidayDates.has(day.date);
    if (companyHoliday && policy.holidays_paid) return true;
    if (weeklyOff && policy.weekly_offs_paid) return true;
    return !weeklyOff && !companyHoliday;
  }).length;

  // Determine Divisor based on salary_calculation_method
  // Use the active payroll policy to select the divisor.
  let denominator = bounds.days;
  if (policy.salary_calculation_method === "calendar_days") {
    denominator = bounds.days;
  } else if (policy.salary_calculation_method === "fixed_30") {
    denominator = Number(policy.fixed_divisor) || 30;
  } else if (policy.salary_calculation_method === "custom_divisor") {
    denominator = Number(policy.custom_divisor) || 30;
  } else if (policy.salary_calculation_method === "working_days") {
    denominator = scheduled.length;
  } else {
    denominator = structure.workday_method === "calendar_days" ? bounds.days : scheduled.length;
  }

  if (!denominator) {
    validation.push({
      level: "error",
      code: "no_scheduled_days",
      message: "No eligible salary divisor days were found.",
    });
    denominator = bounds.days || 30;
  }

  if (effective > bounds.start && effective <= bounds.end) {
    validation.push({
      level: "warning",
      code: "salary_change_mid_month",
      message: `Salary structure becomes effective ${effective}; the period uses this structure for the full month.`,
    });
  }

  const attendance = all(
    "SELECT work_date,status,segments,admin_status FROM attendance WHERE user_id=? AND work_date>=? AND work_date<=?",
    user.id,
    bounds.start,
    bounds.end,
  );
  const attByDate = new Map(attendance.map((a) => [a.work_date, a]));
  const present = attendance.reduce((sum, a) => {
    if (!scheduledSet.has(a.work_date)) return sum;
    const override = String(a.admin_status || "").toLowerCase();
    if (override === "absent") return sum;
    if (override === "half_day") return sum + 0.5;
    if (override === "present") return sum + 1;
    const seg = parse(a.segments, []);
    return (
      sum + (Array.isArray(seg) && seg.some((s) => s.start && s.end) ? 1 : 0)
    );
  }, 0);

  const pending = all(
    "SELECT id,start_date,end_date FROM requests WHERE user_id=? AND kind='Leave' AND status='Pending' AND start_date<=? AND COALESCE(end_date,start_date)>=?",
    user.id,
    bounds.end,
    bounds.start,
  );
  if (pending.length) {
    validation.push({
      level: "warning",
      code: "pending_leave",
      message: `${pending.length} leave request(s) overlap this period; resolve them before final approval.`,
    });
  }

  const categoryByName = new Map(allCategories.map((c) => [c.name, c]));
  const yearlyRows = approvedLeaveRows(user.id, bounds.year);
  const currentLeaves = yearlyRows.filter((r) => {
    const leaveStart = r.start_date || r.created_at?.slice(0, 10) || "";
    const leaveEnd = r.end_date || leaveStart;
    return leaveStart <= bounds.end && leaveEnd >= bounds.start &&
      leaveStart <= activeEnd && leaveEnd >= activeStart;
  });
  const approvedLeaveDates = new Set();
  for (const row of currentLeaves) {
    for (const { date } of leaveDayUnits(row, weeklyOffs, fetchHolidays(row.start_date, row.end_date || row.start_date, ruleCompany)))
      if (date >= bounds.start && date <= bounds.end && date >= activeStart && date <= activeEnd)
        approvedLeaveDates.add(date);
  }
  const missing = scheduledActiveDates.filter((d) => !attByDate.has(d) && !approvedLeaveDates.has(d));
  const open = attendance.filter(
    (a) =>
      a.status === "in" || parse(a.segments, []).some((s) => s.start && !s.end),
  );
  if (open.length) {
    validation.push({
      level: "warning",
      code: "open_attendance",
      message: `${open.length} attendance record(s) still have an open shift.`,
    });
  }

  let usedByType = {};
  for (const row of yearlyRows) {
    if ((row.start_date || "") >= bounds.start) continue;
    const type = requestType(row),
      cat = categoryByName.get(type);
    if (!cat) continue;
    usedByType[type] =
      (usedByType[type] || 0) +
      leaveUnits(
        row,
        weeklyOffs,
        fetchHolidays(row.start_date, row.end_date || row.start_date, ruleCompany),
      );
  }

  const occupied = new Set();
  let paid = 0,
    unpaid = 0,
    paidCapRemaining =
      structure.paid_leave_entitlement == null
        ? Infinity
        : Number(structure.paid_leave_entitlement);

  for (const row of currentLeaves) {
    const type = requestType(row),
      category = categoryByName.get(type);
    if (!category) {
      validation.push({
        level: "warning",
        code: "unknown_leave_type",
        message: `Approved leave ${row.id} uses an unconfigured leave type.`,
      });
      continue;
    }
    const eligible = leaveDayUnits(row, weeklyOffs, fetchHolidays(row.start_date, row.end_date || row.start_date, ruleCompany));
    const adminPayrollStatus = ["Paid", "Unpaid"].includes(row.payroll_leave_status)
      ? row.payroll_leave_status
      : "";
    for (const { date: day, units: unit } of eligible) {
      if (day < bounds.start || day > bounds.end || day < activeStart || day > activeEnd) continue;
      if (occupied.has(day)) {
        validation.push({
          level: "warning",
          code: "overlapping_leave",
          message: `Overlapping approved leave on ${day} was counted once.`,
        });
        continue;
      }
      occupied.add(day);
      if (adminPayrollStatus === "Unpaid" || (!adminPayrollStatus && category.category === "Unpaid")) {
        unpaid += unit;
        continue;
      }
      if (adminPayrollStatus === "Paid") {
        paid += unit;
        continue;
      }
      const monthlyCap = Number(category.monthly_accrual_days) || 0,
        entitlement = monthlyCap
          ? Math.min(
              Number(category.entitlement_days) || 12,
              monthlyCap * Number(start.slice(5, 7)),
            )
          : Number(category.entitlement_days) || 0,
        already = usedByType[type] || 0;
      const available = Math.max(0, entitlement - already);
      const covered = Math.min(unit, available, paidCapRemaining);
      paid += covered;
      if (Number.isFinite(paidCapRemaining)) paidCapRemaining -= covered;
      usedByType[type] = already + covered;
      if (unit > covered) {
        if (category.excess_to_unpaid) unpaid += unit - covered;
        else
          validation.push({
            level: "warning",
            code: "paid_leave_excess",
            message: `Paid leave for ${type} exceeded entitlement; company policy leaves it paid.`,
          });
      }
    }
  }

  const recurringAllowances = parse(structure.allowances_json, []),
    otherEarnings = parse(structure.earnings_json, []),
    recurringDeductions = [];
  const basic = Number(structure.basic_paise) || 0,
    totalAllowances = recurringAllowances.reduce(
      (n, x) => n + (Number(x.amount_paise) || 0),
      0,
    ),
    totalOther = otherEarnings.reduce(
      (n, x) => n + (Number(x.amount_paise) || 0),
      0,
    ),
    monthlyGross = basic + totalAllowances + totalOther;

  // Active days count for proration
  // makeDays is inclusive and receives already-clamped period/employment bounds;
  // this single count is the proration numerator. Leave days never get added here.
  const activeCalendarDays = activeDaysList.length;
  const isProrated = activeStart > bounds.calendar_start || activeEnd < bounds.calendar_end;

  let scheduledRatio = 1;
  let eligibleDays = bounds.days;
  if (isProrated) {
    if (policy.proration_method === "working_days") {
      eligibleDays = scheduledActive;
      scheduledRatio = denominator ? scheduledActive / denominator : 0;
    } else {
      eligibleDays = paidActiveCalendarDays;
      scheduledRatio = denominator ? paidActiveCalendarDays / denominator : 0;
    }
  }

  const gross = Math.round(monthlyGross * scheduledRatio);

  // Leave deduction divisor calculation
  let leaveDivisor = denominator;
  if (policy.leave_deduction_divisor_method === "calendar_days") {
    leaveDivisor = bounds.days;
  } else if (policy.leave_deduction_divisor_method === "working_days") {
    leaveDivisor = scheduled.length || bounds.days;
  } else if (policy.leave_deduction_divisor_method === "fixed_30") {
    leaveDivisor = Number(policy.fixed_divisor) || 30;
  }

  let leaveDeduction = 0;
  if (Number(policy.unpaid_leave_enabled) && unpaid > 0 && leaveDivisor > 0) {
    leaveDeduction = Math.round((monthlyGross * unpaid) / leaveDivisor);
  }

  // Attendance losses are computed once per scheduled date; approved leave never overlaps this deduction.
  let attendanceDeduction = 0;
  let attendanceLossUnits = 0;
  for (const day of scheduledActiveDates) {
    if (approvedLeaveDates.has(day)) continue;
    const row = attByDate.get(day);
    if (!row) { attendanceLossUnits += 1; continue; }
    const override = String(row.admin_status || "").toLowerCase();
    if (override === "absent") attendanceLossUnits += 1;
    else if (override === "half_day") attendanceLossUnits += Number.isFinite(Number(policy.half_day_factor)) ? Number(policy.half_day_factor) : 0.5;
    else if (override === "present") continue;
    else {
      const segments = parse(row.segments, []);
      if (!(Array.isArray(segments) && segments.some((segment) => segment.start && segment.end))) attendanceLossUnits += 1;
    }
  }
  if (Number(policy.attendance_deduction_enabled) && attendanceLossUnits > 0 && leaveDivisor > 0) {
    attendanceDeduction = Math.round((monthlyGross * attendanceLossUnits) / leaveDivisor);
  }

  const otherDeductions = [];
  if (attendanceDeduction > 0) {
    otherDeductions.push({
      name: "Attendance Deduction",
      amount_paise: attendanceDeduction,
      reason: `${attendanceLossUnits} unpaid scheduled day equivalent(s)`,
    });
  }

  let lateArrivalCount = 0;
  const shiftParts = /^(\d{2}):(\d{2})$/.exec(policy.shift_start_time || "10:10");
  const shiftStartMinutes = shiftParts ? Number(shiftParts[1]) * 60 + Number(shiftParts[2]) : 610;
  if (Number(policy.late_deduction_enabled) && Number(policy.late_penalty_paise) > 0) {
    for (const day of scheduledActiveDates) {
      if (approvedLeaveDates.has(day)) continue;
      const attendanceRow = attByDate.get(day);
      if (!attendanceRow || attendanceRow.admin_status === "absent") continue;
      const segments = parse(attendanceRow.segments, []);
      const firstStart = Array.isArray(segments) ? segments.find((segment) => segment.start)?.start : null;
      const clockInMinutes = firstStart ? minutesInCompanyTime(firstStart) : null;
      if (clockInMinutes !== null && clockInMinutes > shiftStartMinutes + Number(policy.late_grace_minutes || 0)) lateArrivalCount++;
    }
    if (lateArrivalCount) otherDeductions.push({
      name: "Late arrival penalty",
      amount_paise: lateArrivalCount * Number(policy.late_penalty_paise),
      reason: `${lateArrivalCount} arrival(s) after ${policy.shift_start_time || "10:10"} + ${Number(policy.late_grace_minutes || 0)} minute grace`,
      source: "attendance_policy",
    });
  }

  const deductionRules = all(
    "SELECT * FROM payroll_deduction_rules WHERE company_id=? AND active=1 AND ((frequency='monthly' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)) OR (frequency='one_time' AND period=?)) AND (employee_id IS NULL OR employee_id='') ORDER BY name",
    ruleCompany, bounds.end, bounds.start, period,
  ).concat(all(
    "SELECT * FROM payroll_deduction_rules WHERE company_id=? AND employee_id=? AND active=1 AND ((frequency='monthly' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)) OR (frequency='one_time' AND period=?)) ORDER BY name",
    ruleCompany, user.id, bounds.end, bounds.start, period,
  ));
  const proratedBasic = Math.round(basic * scheduledRatio);
  for (const rule of deductionRules) {
    const ruleStart = rule.effective_from > activeStart ? rule.effective_from : activeStart;
    const ruleEndCandidate = rule.effective_to || activeEnd;
    const ruleEnd = ruleEndCandidate < activeEnd ? ruleEndCandidate : activeEnd;
    const ruleDays = makeDays(ruleStart, ruleEnd).length;
    if (!ruleDays) continue;
    const amount = rule.frequency === "one_time"
      ? Number(rule.amount_paise || 0)
      : rule.calculation_method === "percentage"
      ? Math.round(((rule.percentage_basis === "basic" ? proratedBasic : gross) * Number(rule.percentage || 0) / 100) * ruleDays / Math.max(1, activeCalendarDays))
      : Math.round(Number(rule.amount_paise || 0) * ruleDays / bounds.days);
    if (amount > 0) recurringDeductions.push({
      id: rule.id, name: rule.name, amount_paise: amount,
      reason: rule.frequency === "one_time"
        ? `One-time deduction for ${period}`
        : rule.calculation_method === "percentage"
        ? `${Number(rule.percentage)}% of ${rule.percentage_basis} (${ruleDays}/${activeCalendarDays} eligible days)`
        : `INR ${Number(rule.amount_paise || 0) / 100} monthly · ${ruleDays}/${bounds.days} days`,
      source: "configured_rule",
    });
  }
  for (const item of parse(structure.deductions_json, [])) {
    const amount = Math.round(Number(item.amount_paise || 0) * scheduledRatio);
    if (amount > 0) recurringDeductions.push({
      name: clean(item.name, 100) || "Salary structure deduction",
      amount_paise: amount,
      reason: "Employee salary structure",
      source: "salary_structure",
    });
  }
  otherDeductions.push(...recurringDeductions);
  const totalDeductions = leaveDeduction + otherDeductions.reduce((sum, item) => sum + Number(item.amount_paise || 0), 0);
  const net = gross - totalDeductions;
  if (net < 0) {
    validation.push({
      level: "error",
      code: "negative_net",
      message: "Calculated net pay is negative.",
    });
  }

  // Active weekly offs & holidays in period
  const activeWeeklyOffs = activeDaysList.filter((d) => weeklyOffs.has(d.weekday)).length;
  const activeHolidays = activeDaysList.filter((d) => !weeklyOffs.has(d.weekday) && holidayDates.has(d.date)).length;

  // Payable days calculation
  let payableDays = present || Math.max(0, scheduledActive - unpaid);
  if (policy.salary_calculation_method === "calendar_days" || policy.proration_method === "calendar_days") {
    payableDays = Math.max(0, eligibleDays - unpaid - (attendanceDeduction > 0 ? attendanceLossUnits : 0));
  }

  const calculation = {
    period,
    payroll_period_start: bounds.start,
    payroll_period_end: bounds.end,
    joining_date: startDate,
    last_working_date: employee.exit_date || "",
    employment_period_start: activeStart,
    employment_period_end: activeEnd,
    eligible_employment_days: activeCalendarDays,
    policy_id: policy.id,
    policy_name: policy.name,
    policy_version: policy.version,
    method: policy.salary_calculation_method,
    proration_method: policy.proration_method,
    leave_deduction_divisor_method: policy.leave_deduction_divisor_method,
    annual_ctc_paise: Number(
      q("SELECT annual_ctc_paise FROM employees WHERE user_id=?", user.id)
        ?.annual_ctc_paise || employee.annual_ctc_paise || monthlyGross * 12,
    ),
    monthly_ctc_paise: monthlyGross,
    daily_salary_paise: denominator ? monthlyGross / denominator : 0,
    divisor_days: denominator,
    leave_divisor_days: leaveDivisor,
    scheduled_days: scheduled.length,
    eligible_scheduled_days: scheduledActive,
    calendar_days: bounds.days,
    active_calendar_days: activeCalendarDays,
    eligible_days: eligibleDays,
    present_days: present,
    paid_leave_days: paid,
    unpaid_leave_days: unpaid,
    weekly_offs: activeWeeklyOffs,
    holidays: activeHolidays,
    paid_weekly_off_days: policy.weekly_offs_paid ? activeWeeklyOffs : 0,
    paid_holidays: policy.holidays_paid ? activeHolidays : 0,
    weekly_offs_paid: Boolean(policy.weekly_offs_paid),
    holidays_paid: Boolean(policy.holidays_paid),
    payable_days: payableDays,
    gross_paise: gross,
    gross_prorated_paise: gross,
    leave_deduction_paise: leaveDeduction,
    attendance_deduction_paise: attendanceDeduction,
    other_deductions_paise: otherDeductions.reduce((sum, item) => sum + Number(item.amount_paise || 0), 0),
    total_deductions_paise: totalDeductions,
    final_net_paise: net,
    net_paise: net,
    basic_paise: basic,
    allowances: recurringAllowances,
    other_earnings: otherEarnings,
    recurring_deductions: recurringDeductions,
    approved_leaves: currentLeaves.map((r) => {
      const eligibleLeaveUnits = leaveDayUnits(
        r,
        weeklyOffs,
        fetchHolidays(r.start_date, r.end_date || r.start_date, ruleCompany),
      ).filter((x) => x.date >= bounds.start && x.date <= bounds.end && x.date >= activeStart && x.date <= activeEnd)
        .reduce((sum, x) => sum + x.units, 0);
      return {
        id: r.id,
        type: requestType(r),
        days: eligibleLeaveUnits,
        payroll_status: r.payroll_leave_status || categoryByName.get(requestType(r))?.category || "",
        status: r.status,
      };
    }),
    weekly_off_days: [...weeklyOffs],
    holidays_list: holidayRows.map((h) => ({
      start_date: h.start_date,
      end_date: h.end_date,
      title: h.title,
    })),
    salary_effective_from: effective,
    missing_attendance_dates: missing,
    attendance_loss_units: attendanceLossUnits,
    late_arrival_count: lateArrivalCount,
    shift_start_time: policy.shift_start_time || "10:10",
  };

  return {
    user_id: user.id,
    salary_structure_id: structure.id,
    policy_id: policy.id,
    policy_version: policy.version,
    calendar_days: bounds.days,
    scheduled_days: scheduled.length,
    present_days: present,
    paid_leave_days: paid,
    unpaid_leave_days: unpaid,
    payable_days: payableDays,
    basic_paise: Math.round(basic * scheduledRatio),
    allowances_json: JSON.stringify(
      recurringAllowances.map((x) => ({
        ...x,
        amount_paise: Math.round(x.amount_paise * scheduledRatio),
      })),
    ),
    earnings_json: JSON.stringify(
      otherEarnings.map((x) => ({
        ...x,
        amount_paise: Math.round((Number(x.amount_paise || 0) * scheduledRatio)),
      })),
    ),
    gross_paise: gross,
    leave_deduction_paise: leaveDeduction,
    other_deductions_json: JSON.stringify(otherDeductions),
    total_deductions_paise: totalDeductions,
    net_paise: net,
    calculation_json: JSON.stringify(calculation),
    validation_json: JSON.stringify(validation),
    validation,
  };
}
function salaryFor(userId, period) {
  return q(
    "SELECT * FROM salary_structures WHERE user_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1",
    userId,
    `${period}-31`,
  );
}
function saveCtcStructure(userId, annualPaise, effective, actor) {
  const monthly = Math.round(annualPaise / 12),
    basic = Math.round(monthly * 0.5),
    hra = Math.round(monthly * 0.2),
    telephone = Math.round(monthly * (1900 / 15000)),
    other = Math.max(0, monthly - basic - hra - telephone),
    allowances = [
      { name: "HRA", amount_paise: hra },
      { name: "Telephone & Internet", amount_paise: telephone },
      { name: "Other Allowance", amount_paise: other },
    ];
  run(
    `INSERT INTO salary_structures(id,user_id,effective_from,currency,basic_paise,allowances_json,earnings_json,deductions_json,workday_method,weekly_offs_json,paid_leave_entitlement,created_by,created_at) VALUES(?, ?, ?, 'INR', ?, ?, '[]', '[]', 'working_days', '[0,6]', 12, ?, ?) ON CONFLICT(user_id,effective_from) DO UPDATE SET basic_paise=excluded.basic_paise,allowances_json=excluded.allowances_json,earnings_json='[]',deductions_json='[]',workday_method='working_days',weekly_offs_json='[0,6]',paid_leave_entitlement=12`,
    id(),
    userId,
    effective,
    basic,
    JSON.stringify(allowances),
    actor,
    now(),
  );
  return q(
    "SELECT id FROM salary_structures WHERE user_id=? AND effective_from=?",
    userId,
    effective,
  );
}
function recalcPeriod(periodId, actor) {
  const period = q("SELECT * FROM payroll_periods WHERE id=?", periodId);
  if (!period || !["Draft", "Validation"].includes(period.status)) return false;
  const categories = all("SELECT * FROM leave_categories");
  const employees = all(
    "SELECT u.id,u.name,u.active,u.company_id,e.start_date,e.exit_date,e.annual_ctc_paise FROM users u JOIN employees e ON e.user_id=u.id WHERE u.role='employee' AND u.active=1 AND COALESCE(u.company_id,'')=? ORDER BY u.name",
    period.company_id || "",
  );
  const missing = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const employee of employees) {
      const structure = salaryFor(employee.id, period.period);
      if (!structure) {
        missing.push({
          level: "error",
          employee_id: employee.id,
          name: employee.name,
          code: "missing_salary",
          message: "No salary structure effective for this payroll period.",
        });
        continue;
      }
      const item = calculateEmployee(
        employee,
        employee,
        structure,
        period.period,
        categories,
        null,
        {
          start_date: period.period_start_date || monthBounds(period.period).start,
          end_date: period.period_end_date || monthBounds(period.period).end,
        },
      );
      const existing = q(
        "SELECT id FROM payroll_items WHERE period_id=? AND user_id=?",
        periodId,
        employee.id,
      );
      if (existing) {
        run(
          "UPDATE payroll_items SET salary_structure_id=?,calendar_days=?,scheduled_days=?,present_days=?,paid_leave_days=?,unpaid_leave_days=?,payable_days=?,basic_paise=?,allowances_json=?,earnings_json=?,gross_paise=?,leave_deduction_paise=?,other_deductions_json=?,total_deductions_paise=?,net_paise=?,calculation_json=?,validation_json=?,policy_id=?,policy_version=?,updated_at=? WHERE id=?",
          item.salary_structure_id,
          item.calendar_days,
          item.scheduled_days,
          item.present_days,
          item.paid_leave_days,
          item.unpaid_leave_days,
          item.payable_days,
          item.basic_paise,
          item.allowances_json,
          item.earnings_json,
          item.gross_paise,
          item.leave_deduction_paise,
          item.other_deductions_json,
          item.total_deductions_paise,
          item.net_paise,
          item.calculation_json,
          item.validation_json,
          item.policy_id || null,
          item.policy_version || 1,
          now(),
          existing.id,
        );
      } else {
        run(
          "INSERT INTO payroll_items(id,period_id,user_id,salary_structure_id,calendar_days,scheduled_days,present_days,paid_leave_days,unpaid_leave_days,payable_days,basic_paise,allowances_json,earnings_json,gross_paise,leave_deduction_paise,other_deductions_json,total_deductions_paise,net_paise,calculation_json,validation_json,policy_id,policy_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id(),
          periodId,
          item.user_id,
          item.salary_structure_id,
          item.calendar_days,
          item.scheduled_days,
          item.present_days,
          item.paid_leave_days,
          item.unpaid_leave_days,
          item.payable_days,
          item.basic_paise,
          item.allowances_json,
          item.earnings_json,
          item.gross_paise,
          item.leave_deduction_paise,
          item.other_deductions_json,
          item.total_deductions_paise,
          item.net_paise,
          item.calculation_json,
          item.validation_json,
          item.policy_id || null,
          item.policy_version || 1,
          now(),
          now(),
        );
      }
    }
    for (const row of all(
      "SELECT id,user_id FROM payroll_items WHERE period_id=?",
      periodId,
    ))
      if (!employees.some((e) => e.id === row.user_id))
        run("DELETE FROM payroll_items WHERE id=?", row.id);
    const validation = [
      ...missing,
      ...all(
        "SELECT validation_json FROM payroll_items WHERE period_id=?",
        periodId,
      ).flatMap((x) => parse(x.validation_json, [])),
    ];
    run(
      "UPDATE payroll_periods SET status='Validation',validation_json=?,updated_at=? WHERE id=?",
      JSON.stringify(validation),
      now(),
      periodId,
    );
    audit(
      actor,
      "Generated/recalculated payroll",
      "payroll_period",
      periodId,
      period.period,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return true;
}
function autoPreparePreviousMonth() {
  try {
    if (!db || !q("SELECT id FROM salary_structures LIMIT 1")) return;
    const admins = all(
      "SELECT id,COALESCE(company_id,'') AS company_id FROM users WHERE role='admin' AND active=1 ORDER BY created_at",
    );
    if (!admins.length) return;
    const d = new Date(),
      period = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
        .toISOString()
        .slice(0, 7);
    for (const admin of admins) {
      if (q("SELECT id FROM payroll_periods WHERE company_id=? AND period=?", admin.company_id, period)) continue;
      const actor = admin.id, pid = id(), at = now();
      run("INSERT INTO payroll_periods(id,company_id,period,status,created_by,created_at,updated_at) VALUES(?,?,?,'Draft',?,?,?)", pid, admin.company_id, period, actor, at, at);
      recalcPeriod(pid, actor);
      audit(actor, "Automatically prepared monthly payroll draft", "payroll_period", pid, period);
    }
  } catch (error) {
    console.error("Monthly payroll draft preparation failed:", error.message);
  }
}
function recalcDraftsForUser(userId, actor, date) {
  const period = date.slice(0, 7);
  const row = q(
    "SELECT p.id FROM payroll_periods p JOIN users u ON u.id=? WHERE p.period=? AND p.company_id=COALESCE(u.company_id,'') AND p.status IN ('Draft','Validation')",
    userId, period,
  );
  if (row) recalcPeriod(row.id, actor);
}
function serializeItem(row) {
  const adjustments = all(
    "SELECT a.*,u.name AS created_by_name FROM payroll_adjustments a JOIN users u ON u.id=a.created_by WHERE a.payroll_item_id=? ORDER BY a.created_at",
    row.id,
  );
  const adjustment_total_paise = adjustments.reduce(
    (sum, a) => sum + Number(a.amount_paise || 0),
    0,
  );
  return {
    ...row,
    adjustments,
    adjustment_total_paise,
    adjusted_net_paise: Number(row.net_paise) + adjustment_total_paise,
    allowances: parse(row.allowances_json, []),
    earnings: parse(row.earnings_json, []),
    other_deductions: parse(row.other_deductions_json, []),
    calculation: parse(row.calculation_json, {}),
    validation: parse(row.validation_json, []),
  };
}
function serializePeriod(row) {
  return {
    ...row,
    validation: parse(row.validation_json, []),
    items: all(
      "SELECT i.*,u.name,u.email FROM payroll_items i JOIN users u ON u.id=i.user_id WHERE i.period_id=? ORDER BY u.name",
      row.id,
    ).map(serializeItem),
  };
}
function encryptText(text) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv),
    ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
function decryptText(row) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(row.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
function periodItemForUser(item, user) {
  if (item.user_id === user.id) return true;
  return isRole(user, [ADMIN, HR, PAYROLL]);
}

async function routeUpgrade(req, res, url, user, json) {
  const p = url.pathname,
    method = req.method;
  if (
    p === "/api/hrm/daily-updates" &&
    (method === "GET" || method === "POST")
  ) {
    if (method === "GET") {
      const requested = clean(url.searchParams.get("user_id"), 80),
        allAllowed = isRole(user, [ADMIN, HR, MANAGER]) && !requested,
        target = requested || user.id;
      if (!sameCompany(user, target)) fail(404, "Employee not found.");
      if (
        !allAllowed &&
        target !== user.id &&
        !requireRole(user, [ADMIN, HR, MANAGER], json, res)
      )
        return true;
      const employee = allAllowed
        ? null
        : q(
            "SELECT u.id,e.department FROM users u JOIN employees e ON e.user_id=u.id WHERE u.id=? AND u.role='employee'",
            target,
          );
      if (!allAllowed && !employee) fail(404, "Employee not found.");
      if (
        user.role === MANAGER &&
        !allAllowed &&
        employee.department !==
          q("SELECT department FROM employees WHERE user_id=?", user.id)
            ?.department
      ) {
        json(res, 403, {
          error: "Managers can only view updates in their department.",
        });
        return true;
      }
      const clauses = [],
        args = [];
      const scope = companyWhere(user, "u");
      clauses.push(scope.sql); args.push(...scope.args);
      if (!allAllowed) {
        clauses.push("d.user_id=?");
        args.push(target);
      }
      if (user.role === MANAGER) {
        clauses.push(
          "u.id IN (SELECT user_id FROM employees WHERE department=(SELECT department FROM employees WHERE user_id=?))",
        );
        args.push(user.id);
      }
      const from = clean(url.searchParams.get("from"), 10),
        to = clean(url.searchParams.get("to"), 10),
        status = clean(url.searchParams.get("status"), 30),
        project = clean(url.searchParams.get("project"), 120);
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
        clauses.push("d.work_date>=?");
        args.push(from);
      }
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        clauses.push("d.work_date<=?");
        args.push(to);
      }
      if (status) {
        clauses.push("d.status=?");
        args.push(status);
      }
      if (project) {
        clauses.push("d.project=?");
        args.push(project);
      }
      const rows = all(
        `SELECT d.*,u.name AS employee_name,t.title AS task_title FROM daily_updates d JOIN users u ON u.id=d.user_id LEFT JOIN tasks t ON t.id=d.task_id ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY d.work_date DESC,d.updated_at DESC LIMIT 500`,
        ...args,
      ).map((r) => ({
        ...r,
        comments: all(
          "SELECT c.id,c.body,c.created_at,u.name AS author_name FROM daily_update_comments c JOIN users u ON u.id=c.author_id WHERE c.update_id=? ORDER BY c.created_at",
          r.id,
        ),
      }));
      return json(res, 200, {
        updates: rows,
        employee_id: allAllowed ? null : target,
        history: rows.map((r) => ({
          ...r,
          history: all(
            "SELECT h.action,h.created_at,h.actor_id,u.name AS actor_name FROM daily_update_history h JOIN users u ON u.id=h.actor_id WHERE h.update_id=? ORDER BY h.created_at DESC",
            r.id,
          ),
          comments: all(
            "SELECT c.id,c.body,c.created_at,u.name AS author_name FROM daily_update_comments c JOIN users u ON u.id=c.author_id WHERE c.update_id=? ORDER BY c.created_at",
            r.id,
          ),
        })),
      });
    }
    const d = await body(req),
      title = clean(d.title, 180),
      description = clean(d.description, 5000),
      workDate = clean(d.work_date, 10),
      priority = ["Low", "Medium", "High", "Urgent"].includes(d.priority)
        ? d.priority
        : "Medium",
      status = ["Not Started", "In Progress", "Blocked", "Completed"].includes(
        d.status,
      )
        ? d.status
        : "In Progress",
      progress = Number(d.progress ?? (status === "Completed" ? 100 : 0)),
      spent =
        d.time_spent === "" || d.time_spent == null
          ? null
          : Number(d.time_spent);
    if (!title || !description || !/^\d{4}-\d{2}-\d{2}$/.test(workDate))
      fail(400, "Date, task title, and detailed description are required.");
    if (!Number.isInteger(progress) || progress < 0 || progress > 100)
      fail(400, "Progress must be from 0 to 100.");
    if (spent !== null && (!Number.isFinite(spent) || spent < 0 || spent > 24))
      fail(400, "Time spent must be between 0 and 24 hours.");
    const taskId = clean(d.task_id, 80) || null;
    if (taskId) {
      const task = q("SELECT t.id,t.user_id,u.company_id FROM tasks t JOIN users u ON u.id=t.user_id WHERE t.id=?", taskId);
      if (!task || task.user_id !== user.id)
        fail(400, "Select one of your assigned tasks.");
    }
    const uid = id(),
      at = now(),
      row = {
        user_id: user.id,
        task_id: taskId,
        work_date: workDate,
        title,
        description,
        project: clean(d.project, 120),
        client: clean(d.client, 120),
        priority,
        status,
        progress,
        completed_today: clean(d.completed_today, 3000),
        pending_work: clean(d.pending_work, 3000),
        blockers: clean(d.blockers, 3000),
        next_steps: clean(d.next_steps, 3000),
        time_spent: spent,
      };
    run(
      "INSERT INTO daily_updates(id,user_id,task_id,work_date,title,description,project,client,priority,status,progress,completed_today,pending_work,blockers,next_steps,time_spent,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      uid,
      row.user_id,
      row.task_id,
      row.work_date,
      row.title,
      row.description,
      row.project,
      row.client,
      row.priority,
      row.status,
      row.progress,
      row.completed_today,
      row.pending_work,
      row.blockers,
      row.next_steps,
      row.time_spent,
      at,
      at,
    );
    run(
      "INSERT INTO daily_update_history VALUES(?,?,?,?,?,?)",
      id(),
      uid,
      user.id,
      "Submitted",
      JSON.stringify(row),
      at,
    );
    audit(
      user.id,
      "Submitted daily work update",
      "daily_update",
      uid,
      `${workDate} · ${title}`,
    );
    for (const admin of all(
      "SELECT id FROM users WHERE role IN ('admin','hr_manager') AND active=1 AND COALESCE(company_id,'')=?",
      user.company_id || "",
    ))
      notify(
        admin.id,
        "Daily work update submitted",
        `${user.name} · ${workDate}: ${title}`,
        "work_update",
        uid,
      );
    return json(res, 201, { id: uid });
  }
  const updateMatch = p.match(
    /^\/api\/hrm\/daily-updates\/([\w-]+)(?:\/(history|comments))?$/,
  );
  if (updateMatch && updateMatch[2] === "comments" && method === "POST") {
    const row = q("SELECT * FROM daily_updates WHERE id=?", updateMatch[1]);
    if (!row) fail(404, "Daily update not found.");
    if (!sameCompany(user, row.user_id)) fail(404, "Daily update not found.");
    if (!requireRole(user, [ADMIN, HR, MANAGER], json, res)) return true;
    if (
      user.role === MANAGER &&
      q("SELECT department FROM employees WHERE user_id=?", row.user_id)
        ?.department !==
        q("SELECT department FROM employees WHERE user_id=?", user.id)
          ?.department
    ) {
      json(res, 403, {
        error: "Managers can only comment on updates in their department.",
      });
      return true;
    }
    const d = await body(req),
      note = clean(d.body, 3000);
    if (!note) fail(400, "Feedback cannot be empty.");
    const cid = id(),
      at = now();
    run(
      "INSERT INTO daily_update_comments VALUES(?,?,?,?,?)",
      cid,
      row.id,
      user.id,
      note,
      at,
    );
    audit(
      user.id,
      "Commented on daily work update",
      "daily_update",
      row.id,
      note.slice(0, 500),
    );
    notify(
      row.user_id,
      "Admin feedback on daily update",
      note.slice(0, 500),
      "work_update",
      row.id,
    );
    return json(res, 201, { id: cid });
  }
  if (updateMatch && method === "GET" && updateMatch[2] === "history") {
    const row = q("SELECT * FROM daily_updates WHERE id=?", updateMatch[1]);
    if (!row) fail(404, "Daily update not found.");
    if (!sameCompany(user, row.user_id)) fail(404, "Daily update not found.");
    if (
      row.user_id !== user.id &&
      !requireRole(user, [ADMIN, HR, MANAGER], json, res)
    )
      return true;
    if (
      user.role === MANAGER &&
      row.user_id !== user.id &&
      q("SELECT department FROM employees WHERE user_id=?", row.user_id)
        ?.department !==
        q("SELECT department FROM employees WHERE user_id=?", user.id)
          ?.department
    ) {
      json(res, 403, {
        error: "Managers can only view updates in their department.",
      });
      return true;
    }
    return json(res, 200, {
      history: all(
        "SELECT h.action,h.snapshot_json,h.created_at,u.name AS actor_name FROM daily_update_history h JOIN users u ON u.id=h.actor_id WHERE h.update_id=? ORDER BY h.created_at DESC",
        row.id,
      ),
    });
  }
  if (updateMatch && method === "PUT" && !updateMatch[2]) {
    const row = q("SELECT * FROM daily_updates WHERE id=?", updateMatch[1]);
    if (!row) fail(404, "Daily update not found.");
    if (!sameCompany(user, row.user_id)) fail(404, "Daily update not found.");
    if (row.user_id !== user.id && !requireRole(user, [ADMIN, HR], json, res))
      return true;
    const d = await body(req),
      title = clean(d.title, 180),
      description = clean(d.description, 5000),
      date = clean(d.work_date, 10),
      progress = Number(d.progress),
      status = ["Not Started", "In Progress", "Blocked", "Completed"].includes(
        d.status,
      )
        ? d.status
        : "";
    if (
      !title ||
      !description ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !status ||
      !Number.isInteger(progress) ||
      progress < 0 ||
      progress > 100
    )
      fail(
        400,
        "Provide a valid date, title, description, status, and progress from 0 to 100.",
      );
    const snapshot = {
      work_date: date,
      title,
      description,
      project: clean(d.project, 120),
      client: clean(d.client, 120),
      priority: ["Low", "Medium", "High", "Urgent"].includes(d.priority)
        ? d.priority
        : "Medium",
      status,
      progress,
      completed_today: clean(d.completed_today, 3000),
      pending_work: clean(d.pending_work, 3000),
      blockers: clean(d.blockers, 3000),
      next_steps: clean(d.next_steps, 3000),
      time_spent: d.time_spent === "" ? null : Number(d.time_spent),
    };
    run(
      "UPDATE daily_updates SET work_date=?,title=?,description=?,project=?,client=?,priority=?,status=?,progress=?,completed_today=?,pending_work=?,blockers=?,next_steps=?,time_spent=?,updated_at=? WHERE id=?",
      snapshot.work_date,
      snapshot.title,
      snapshot.description,
      snapshot.project,
      snapshot.client,
      snapshot.priority,
      snapshot.status,
      snapshot.progress,
      snapshot.completed_today,
      snapshot.pending_work,
      snapshot.blockers,
      snapshot.next_steps,
      snapshot.time_spent,
      now(),
      row.id,
    );
    run(
      "INSERT INTO daily_update_history VALUES(?,?,?,?,?,?)",
      id(),
      row.id,
      user.id,
      "Edited",
      JSON.stringify(snapshot),
      now(),
    );
    audit(
      user.id,
      "Edited daily work update",
      "daily_update",
      row.id,
      `${snapshot.work_date} · ${snapshot.title}`,
    );
    return json(res, 200, { ok: true });
  }
  if (p === "/api/hrm/employees" && method === "GET") {
    if (!requireRole(user, [ADMIN, HR, PAYROLL, MANAGER], json, res))
      return true;
    const scope = companyWhere(user, "u");
    const rows = isRole(user, [MANAGER])
      ? all(
          `SELECT u.id,u.name,u.email,u.role,u.active,e.employee_code,e.title,e.department,e.location,e.start_date,e.exit_date,e.manager_id,e.profile_updated_at FROM users u JOIN employees e ON e.user_id=u.id WHERE e.department=(SELECT department FROM employees WHERE user_id=?) AND u.role='employee' AND ${scope.sql} ORDER BY u.name`,
          user.id,
          ...scope.args,
        )
      : all(
          `SELECT u.id,u.name,u.email,u.role,u.active,e.employee_code,e.title,e.department,e.location,e.start_date,e.exit_date,e.manager_id,e.profile_updated_at FROM users u JOIN employees e ON e.user_id=u.id WHERE u.role='employee' AND ${scope.sql} ORDER BY u.name`,
          ...scope.args,
        );
    const employees = rows.map((x) => ({
      ...x,
      active_projects: Number(
        q(
          "SELECT count(*) n FROM employee_projects WHERE user_id=? AND status='Active'",
          x.id,
        )?.n || 0,
      ),
      task_summary: all(
        "SELECT status,count(*) AS count FROM tasks WHERE user_id=? GROUP BY status",
        x.id,
      ),
      last_activity:
        q(
          "SELECT max(created_at) AS at FROM (SELECT created_at FROM activity_logs WHERE user_id=? UNION ALL SELECT updated_at AS created_at FROM daily_updates WHERE user_id=? UNION ALL SELECT updated_at AS created_at FROM tasks WHERE user_id=?)",
          x.id,
          x.id,
          x.id,
        )?.at || null,
    }));
    const managers = all(
      `SELECT u.id,u.name,u.role,u.active FROM users u WHERE u.role IN ('admin','hr_manager','manager') AND u.active=1 AND ${companyWhere(user, "u").sql} ORDER BY u.name`,
      ...companyWhere(user, "u").args,
    );
    return json(res, 200, { employees, managers });
  }
  const profileMatch = p.match(/^\/api\/hrm\/employees\/([\w-]+)\/profile$/);
  if (profileMatch && (method === "GET" || method === "PUT")) {
    const uid = profileMatch[1],
      target = q(
        "SELECT u.id,u.company_id,u.name,u.email,u.role,u.active,u.created_at,e.user_id,e.employee_code,e.exit_date,e.address,e.date_of_birth,e.responsibilities,e.skills_json,e.manager_id,e.profile_updated_at,e.title,e.department,e.location,e.phone,e.emergency_contact,e.start_date,e.avatar_data,e.bio,e.pronouns,e.linkedin_url,e.website_url,e.interests,e.certifications_json,e.annual_ctc_paise FROM users u JOIN employees e ON e.user_id=u.id WHERE u.id=? AND u.role='employee'",
        uid,
      );
    if (!target) fail(404, "Employee not found.");
    if (user.role !== SUPER_ADMIN && String(target.company_id || "") !== String(user.company_id || "")) fail(404, "Employee not found.");
    if (
      uid !== user.id &&
      !requireRole(user, [ADMIN, HR, PAYROLL, MANAGER], json, res)
    )
      return true;
    if (
      user.role === MANAGER &&
      target.department !==
        q("SELECT department FROM employees WHERE user_id=?", user.id)
          ?.department
    ) {
      json(res, 403, {
        error: "Managers can only view employees in their department.",
      });
      return true;
    }
    if (method === "GET") {
      const tasks = all(
          "SELECT * FROM tasks WHERE user_id=? ORDER BY COALESCE(due_date,'9999-12-31'),created_at DESC",
          uid,
        ),
        updates = all(
          "SELECT * FROM daily_updates WHERE user_id=? ORDER BY work_date DESC,updated_at DESC LIMIT 100",
          uid,
        ).map((x) => ({
          ...x,
          comments: all(
            "SELECT c.id,c.body,c.created_at,u.name AS author_name FROM daily_update_comments c JOIN users u ON u.id=c.author_id WHERE c.update_id=? ORDER BY c.created_at",
            x.id,
          ),
        })),
        projects = all(
          "SELECT * FROM employee_projects WHERE user_id=? ORDER BY status,project",
          uid,
        ),
        attendance = all(
          "SELECT id,work_date,segments,status FROM attendance WHERE user_id=? ORDER BY work_date DESC LIMIT 400",
          uid,
        ),
        requests = all(
          "SELECT id,kind,leave_type,details,start_date,end_date,days,status,decision_note,payroll_leave_status,created_at,decided_at FROM requests WHERE user_id=? ORDER BY created_at DESC LIMIT 300",
          uid,
        ),
        payroll = all(
          "SELECT i.*,p.period,p.status AS period_status,p.paid_at FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id WHERE i.user_id=? ORDER BY p.period DESC LIMIT 36",
          uid,
        ).filter(
          (x) =>
            isRole(user, [ADMIN, PAYROLL, HR]) ||
            ["Published", "Paid"].includes(x.period_status),
        ),
        stats = {
          total_tasks: tasks.length,
          completed: tasks.filter((t) => t.status === "Completed").length,
          in_progress: tasks.filter((t) =>
            ["In Progress", "Accepted", "Pending Review"].includes(t.status),
          ).length,
          pending: tasks.filter(
            (t) =>
              ![
                "Completed",
                "In Progress",
                "Accepted",
                "Pending Review",
              ].includes(t.status),
          ).length,
          blocked: tasks.filter((t) => t.status === "Blocked").length,
          overdue: tasks.filter(
            (t) =>
              t.due_date &&
              t.due_date < new Date().toISOString().slice(0, 10) &&
              t.status !== "Completed",
          ).length,
          active_projects: projects.filter((x) => x.status === "Active").length,
          daily_updates: updates.length,
        };
      const activity = all(
        "SELECT * FROM (SELECT a.action,a.details,a.created_at,u.name AS actor_name FROM activity_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.user_id=? UNION ALL SELECT h.action,h.details,h.created_at,u.name FROM task_history h JOIN tasks t ON t.id=h.task_id JOIN users u ON u.id=h.actor_id WHERE t.user_id=? UNION ALL SELECT h.action,d.title,h.created_at,u.name FROM daily_update_history h JOIN daily_updates d ON d.id=h.update_id JOIN users u ON u.id=h.actor_id WHERE d.user_id=? UNION ALL SELECT a.action,a.details,a.created_at,u.name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.entity_id=? AND a.entity IN ('employee_profile','employee_project')) ORDER BY created_at DESC LIMIT 200",
        uid,
        uid,
        uid,
        uid,
      );
      return json(res, 200, {
        employee: {
          ...target,
          skills: parse(target.skills_json, []),
          certifications: parse(target.certifications_json, []),
          manager_name:
            q("SELECT name FROM users WHERE id=?", target.manager_id)?.name ||
            "",
        },
        leaveCategories: all(
          "SELECT name,category,entitlement_days,monthly_accrual_days FROM leave_categories ORDER BY name",
        ),
        stats,
        tasks,
        updates,
        projects,
        attendance,
        requests,
        payroll,
        activity,
      });
    }
    const d = await body(req),
      self = uid === user.id,
      canManage = isRole(user, [ADMIN, HR]);
    if (!self && !canManage) {
      json(res, 403, {
        error: "Only HR or Admin can edit another employee profile.",
      });
      return true;
    }
    const personal = {
      phone: clean(d.phone, 40),
      emergency_contact: clean(d.emergency_contact, 180),
      address: clean(d.address, 500),
      date_of_birth: clean(d.date_of_birth, 10),
    };
    if (
      personal.date_of_birth &&
      !/^\d{4}-\d{2}-\d{2}$/.test(personal.date_of_birth)
    )
      fail(400, "Enter a valid date of birth.");
    const fields = [
        "phone=?",
        "emergency_contact=?",
        "address=?",
        "date_of_birth=?",
        "bio=?",
        "pronouns=?",
        "linkedin_url=?",
        "website_url=?",
        "interests=?",
        "certifications_json=?",
        "avatar_data=?",
        "responsibilities=?",
        "skills_json=?",
      ],
      args = [
        personal.phone,
        personal.emergency_contact,
        personal.address,
        personal.date_of_birth,
        clean(d.bio === undefined ? target.bio : d.bio, 2000),
        clean(d.pronouns === undefined ? target.pronouns : d.pronouns, 80),
        clean(
          d.linkedin_url === undefined ? target.linkedin_url : d.linkedin_url,
          300,
        ),
        clean(
          d.website_url === undefined ? target.website_url : d.website_url,
          300,
        ),
        clean(d.interests === undefined ? target.interests : d.interests, 500),
        JSON.stringify(
          (Array.isArray(d.certifications)
            ? d.certifications
            : parse(target.certifications_json, [])
          )
            .map((x) => clean(x, 100))
            .filter(Boolean)
            .slice(0, 30),
        ),
        d.avatar_data === undefined
          ? target.avatar_data
          : safeImageData(d.avatar_data),
        clean(
          d.responsibilities === undefined
            ? target.responsibilities
            : d.responsibilities,
          3000,
        ),
        JSON.stringify(
          (Array.isArray(d.skills) ? d.skills : parse(target.skills_json, []))
            .map((x) => clean(x, 60))
            .filter(Boolean)
            .slice(0, 50),
        ),
      ];
    if (canManage) {
      const code = clean(d.employee_code, 40),
        manager = clean(d.manager_id, 80) || null;
      if (
        code &&
        q(
          "SELECT user_id FROM employees WHERE employee_code=? AND user_id<>?",
          code,
          uid,
        )
      )
        fail(409, "That employee ID is already in use.");
      if (
        manager &&
        !q(
          "SELECT id FROM users WHERE id=? AND role IN ('manager','admin','hr_manager') AND active=1",
          manager,
        )
      )
        fail(400, "Choose a valid active reporting manager.");
      if (d.location && !["Onsite", "Remote", "Hybrid"].includes(d.location))
        fail(400, "Choose Onsite, Remote, or Hybrid as the work location.");
      fields.push(
        "title=?",
        "department=?",
        "location=?",
        "start_date=?",
        "employee_code=?",
        "manager_id=?",
      );
      args.push(
        clean(d.title, 160),
        clean(d.department, 120),
        d.location || target.location,
        clean(d.start_date, 10),
        code,
        manager,
      );
    }
    let ctcEffective = "",
      ctc = 0;
    if (d.annual_ctc !== undefined) {
      if (user.role !== ADMIN) fail(403, "Only Admin can set employee CTC.");
      ctc = amountPaise(d.annual_ctc, "Annual CTC");
      if (ctc <= 0) fail(400, "Annual CTC must be greater than zero.");
      fields.push("annual_ctc_paise=?");
      args.push(ctc);
      ctcEffective = /^\d{4}-\d{2}-\d{2}$/.test(d.ctc_effective_from || "")
        ? d.ctc_effective_from
        : new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date());
    }
    args.push(now(), uid);
    fields.push("profile_updated_at=?");
    run(`UPDATE employees SET ${fields.join(",")} WHERE user_id=?`, ...args);
    if (ctcEffective) {
      saveCtcStructure(uid, ctc, ctcEffective, user.id);
      recalcDraftsForUser(uid, user.id, ctcEffective);
    }
    audit(
      user.id,
      self ? "Updated own profile" : "Updated employee profile",
      "employee_profile",
      uid,
    );
    return json(res, 200, { ok: true });
  }
  if (p === "/api/hrm/employee-entry" && method === "POST") {
    if (!requireRole(user, [ADMIN], json, res)) return true;
    const d = await body(req),
      uid = clean(d.user_id, 80),
      title = clean(d.title, 120),
      details = clean(d.details, 2000);
    if (!q("SELECT id FROM users WHERE id=? AND role='employee'", uid))
      fail(400, "Choose a valid employee.");
    if (!requireCompanyUser(user, uid, json, res)) return true;
    if (!title || !details) fail(400, "Add an entry title and details.");
    run(
      "INSERT INTO activity_logs VALUES(?,?,?,?,?,?)",
      id(),
      uid,
      user.id,
      title,
      details,
      now(),
    );
    audit(
      user.id,
      "Added employee profile entry",
      "employee_profile",
      uid,
      `${title} · ${details}`,
    );
    notify(
      uid,
      "An Admin entry was added to your profile",
      title,
      "profile",
      uid,
    );
    return json(res, 201, { ok: true });
  }
  if (p === "/api/hrm/employee-leave" && method === "POST") {
    if (!requireRole(user, [ADMIN], json, res)) return true;
    const d = await body(req),
      uid = clean(d.user_id, 80),
      leaveType = clean(d.leave_type, 100),
      start = clean(d.start_date, 10),
      end = clean(d.end_date, 10),
      details = clean(d.details, 1000) || "Admin-entered leave";
    if (!q("SELECT id FROM users WHERE id=? AND role='employee'", uid))
      fail(400, "Choose a valid employee.");
    const category = q(
      "SELECT * FROM leave_categories WHERE name=?",
      leaveType,
    );
    if (!sameCompany(user, uid)) fail(404, "Employee not found.");
    if (!category) fail(400, "Choose a configured leave type.");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
      end < start
    )
      fail(400, "Choose a valid leave date range.");
    const eligible = workdays(
        start,
        end,
        new Set([0, 6]),
        fetchHolidays(start, end, user.company_id || ""),
      ).length,
      days = Number(d.days);
    if (
      !Number.isFinite(days) ||
      days <= 0 ||
      days > eligible ||
      Math.round(days * 2) !== days * 2
    )
      fail(
        400,
        `Leave days must be 0.5 or more, use half-day increments, and not exceed ${eligible} eligible day(s).`,
      );
    if (days % 1 === 0.5 && !category.allow_half_day)
      fail(400, "This leave type does not allow half-days.");
    const rid = id(),
      at = now();
    run(
      "INSERT INTO requests(id,user_id,kind,details,start_date,end_date,days,status,decision_note,created_by,created_at,decided_at,leave_type,manual_entry) VALUES(?,?,'Leave',?,?, ?,?,'Approved','Admin entry',?,?,?, ?,1)",
      rid,
      uid,
      `${leaveType}: ${details}`,
      start,
      end,
      days,
      user.id,
      at,
      at,
      leaveType,
    );
    run(
      "INSERT INTO calendar_events(id,title,start_date,end_date,kind,description,approved,created_by,created_at,company_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
      id(),
      `Leave · ${q("SELECT name FROM users WHERE id=?", uid)?.name || "Employee"}`,
      start,
      end,
      "leave",
      details,
      1,
      user.id,
      at,
      user.company_id || "",
    );
    audit(
      user.id,
      "Added employee leave",
      "request",
      rid,
      `${uid} · ${leaveType} · ${days} day(s)`,
    );
    notify(
      uid,
      "Leave record added",
      `${leaveType} · ${days} day(s) from ${start} to ${end} was recorded by Admin.`,
      "leave",
      rid,
    );
    recalcDraftsForUser(uid, user.id, start);
    return json(res, 201, { id: rid, days });
  }
  if (p === "/api/hrm/employee-projects" && method === "POST") {
    if (!requireRole(user, [ADMIN, HR], json, res)) return true;
    const d = await body(req),
      uid = clean(d.user_id, 80),
      project = clean(d.project, 150);
    if (
      !q("SELECT id FROM users WHERE id=? AND role='employee'", uid) ||
      !project
    )
      fail(400, "Select an employee and enter a project name.");
    if (!sameCompany(user, uid)) fail(404, "Employee not found.");
    const pid = id();
    run(
      "INSERT INTO employee_projects(id,user_id,project,client,responsibility,status,start_date,end_date,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      pid,
      uid,
      project,
      clean(d.client, 150),
      clean(d.responsibility, 1000),
      d.status === "Completed" ? "Completed" : "Active",
      clean(d.start_date, 10),
      clean(d.end_date, 10),
      user.id,
      now(),
    );
    audit(
      user.id,
      "Assigned employee to project",
      "employee_project",
      pid,
      `${uid} · ${project}`,
    );
    return json(res, 201, { id: pid });
  }
  const projectMatch = p.match(/^\/api\/hrm\/employee-projects\/([\w-]+)$/);
  if (projectMatch && method === "DELETE") {
    if (!requireRole(user, [ADMIN, HR], json, res)) return true;
    const row = q(
      "SELECT * FROM employee_projects WHERE id=?",
      projectMatch[1],
    );
    if (!row) fail(404, "Project assignment not found.");
    run(
      "UPDATE employee_projects SET status='Archived',end_date=? WHERE id=?",
      now().slice(0, 10),
      row.id,
    );
    audit(
      user.id,
      "Archived employee project assignment",
      "employee_project",
      row.id,
      row.project,
    );
    return json(res, 200, { ok: true });
  }
  if (p === "/api/hrm/bank" && (method === "GET" || method === "PUT")) {
    const d = method === "PUT" ? await body(req) : null,
      uid = clean(url.searchParams.get("user_id") || d?.user_id || user.id, 80);
    if (uid !== user.id && !requireRole(user, PAYROLL_ROLES, json, res))
      return true;
    if (!sameCompany(user, uid)) fail(404, "Bank details not found.");
    if (method === "GET") {
      const row = q("SELECT * FROM bank_accounts WHERE user_id=?", uid);
      if (!row) return json(res, 200, { bank: null });
      let bank = {};
      try {
        bank = parse(decryptText(row), {});
      } catch {
        fail(
          500,
          "Bank information could not be decrypted. Contact an administrator.",
        );
      }
      return json(res, 200, {
        bank: {
          account_holder: bank.account_holder || "",
          bank_name: bank.bank_name || "",
          account_number_masked: bank.account_number
            ? `••••${bank.account_number.slice(-4)}`
            : "",
          ifsc: bank.ifsc || "",
          branch_name: bank.branch_name || "",
          account_type: bank.account_type || "",
          upi_id: bank.upi_id || "",
          status: row.status || "Pending Verification",
          submitted_at: row.submitted_at || row.updated_at,
          verified_at: row.verified_at,
          updated_at: row.updated_at,
          review_note: row.review_note || "",
        },
      });
    }
    const payload = {
      account_holder: clean(d.account_holder, 120),
      bank_name: clean(d.bank_name, 120),
      account_number: clean(d.account_number, 40).replace(/\s/g, ""),
      ifsc: clean(d.ifsc, 20).toUpperCase(),
      branch_name: clean(d.branch_name, 150),
      account_type: clean(d.account_type, 40),
      upi_id: clean(d.upi_id, 120),
    };
    if (
      !payload.account_holder ||
      !payload.bank_name ||
      !payload.account_number ||
      !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(payload.ifsc)
    )
      fail(
        400,
        "Enter account holder, bank, account number, and valid IFSC code.",
      );
    if (
      d.account_number_confirm !== undefined &&
      payload.account_number !==
        clean(d.account_number_confirm, 40).replace(/\s/g, "")
    )
      fail(400, "Account number confirmation does not match.");
    const enc = encryptText(JSON.stringify(payload)),
      at = now(),
      existing = q("SELECT * FROM bank_accounts WHERE user_id=?", uid),
      snapshot = JSON.stringify(enc);
    run(
      "INSERT INTO bank_account_history(id,user_id,actor_id,action,status,encrypted_snapshot,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id(),
      uid,
      user.id,
      existing ? "Changed" : "Submitted",
      "Pending Verification",
      snapshot,
      "",
      at,
    );
    run(
      "INSERT INTO bank_accounts(user_id,ciphertext,iv,tag,updated_by,updated_at,status,submitted_at,verified_at,verified_by,review_note) VALUES(?,?,?,?,?,?,?, ?,NULL,NULL,'') ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,tag=excluded.tag,updated_by=excluded.updated_by,updated_at=excluded.updated_at,status='Pending Verification',submitted_at=excluded.submitted_at,verified_at=NULL,verified_by=NULL,review_note=''",
      uid,
      enc.ciphertext,
      enc.iv,
      enc.tag,
      user.id,
      at,
      "Pending Verification",
      at,
    );
    audit(user.id, "Submitted encrypted bank details", "bank_account", uid);
    for (const admin of all(
      "SELECT id FROM users WHERE role IN ('admin','payroll_manager') AND active=1 AND COALESCE(company_id,'')=?",
      user.company_id || "",
    ))
      if (admin.id !== user.id)
        notify(
          admin.id,
          "Bank details need review",
          `${user.name} submitted bank details for verification.`,
          "bank",
          uid,
        );
    return json(res, 200, { ok: true, status: "Pending Verification" });
  }
  if (p === "/api/hrm/bank/review" && method === "POST") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    const d = await body(req),
      uid = clean(d.user_id, 80),
      status = clean(d.status, 40),
      note = clean(d.note, 1000),
      row = q("SELECT * FROM bank_accounts WHERE user_id=?", uid);
    if (!sameCompany(user, uid)) fail(404, "Bank details not found.");
    if (!row) fail(404, "Bank details not found.");
    if (!["Verified", "Changes Requested", "Rejected"].includes(status))
      fail(400, "Choose a valid verification decision.");
    if (status === "Changes Requested" && !note)
      fail(400, "Explain what needs correction.");
    const at = now(),
      snapshot = JSON.stringify({
        ciphertext: row.ciphertext,
        iv: row.iv,
        tag: row.tag,
      });
    run(
      "INSERT INTO bank_account_history(id,user_id,actor_id,action,status,encrypted_snapshot,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id(),
      uid,
      user.id,
      status,
      status,
      snapshot,
      note,
      at,
    );
    run(
      "UPDATE bank_accounts SET status=?,verified_at=?,verified_by=?,review_note=? WHERE user_id=?",
      status === "Verified" ? status : status,
      status === "Verified" ? at : null,
      status === "Verified" ? user.id : null,
      note,
      uid,
    );
    audit(
      user.id,
      `Bank details ${status.toLowerCase()}`,
      "bank_account",
      uid,
      status === "Verified" ? "Verification approved" : note,
    );
    notify(
      uid,
      `Bank details ${status.toLowerCase()}`,
      status === "Verified" ? "Your bank details have been verified." : note,
      "bank",
      uid,
    );
    return json(res, 200, { ok: true, status });
  }
  if (p === "/api/hrm/bank/reveal" && method === "POST") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    const d = await body(req),
      uid = clean(d.user_id, 80),
      row = q("SELECT * FROM bank_accounts WHERE user_id=?", uid);
    if (!sameCompany(user, uid)) fail(404, "Bank details not found.");
    if (!row) fail(404, "Bank details not found.");
    const bank = parse(decryptText(row), {});
    audit(
      user.id,
      "Viewed full bank account details",
      "bank_account",
      uid,
      "Sensitive bank data accessed; account number not recorded.",
    );
    run(
      "INSERT INTO bank_account_history(id,user_id,actor_id,action,status,encrypted_snapshot,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id(),
      uid,
      user.id,
      "Full details viewed",
      row.status,
      JSON.stringify({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }),
      "",
      now(),
    );
    return json(res, 200, { bank: { ...bank, status: row.status } });
  }
  if (p === "/api/hrm/bank/pending" && method === "GET") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    const rows = all(
      `SELECT b.user_id,b.status,b.submitted_at,b.verified_at,b.review_note,u.name,u.email,e.employee_code,e.title,e.department,e.location FROM bank_accounts b JOIN users u ON u.id=b.user_id JOIN employees e ON e.user_id=u.id WHERE ${companyWhere(user,"u").sql} ORDER BY CASE b.status WHEN 'Pending Verification' THEN 0 WHEN 'Changes Requested' THEN 1 ELSE 2 END,b.submitted_at DESC`,
      ...companyWhere(user,"u").args,
    );
    return json(res, 200, { banks: rows });
  }
  if (p === "/api/hrm/bank/history" && method === "GET") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    const uid = clean(url.searchParams.get("user_id"), 80);
    if (!sameCompany(user, uid)) fail(404, "Bank details not found.");
    if (!q("SELECT user_id FROM bank_accounts WHERE user_id=?", uid))
      return json(res, 200, { history: [] });
    return json(res, 200, {
      history: all(
        "SELECT h.action,h.status,h.note,h.created_at,u.name AS actor_name FROM bank_account_history h JOIN users u ON u.id=h.actor_id WHERE h.user_id=? ORDER BY h.created_at DESC LIMIT 200",
        uid,
      ),
    });
  }
  if (p === "/api/hrm/roles" && method === "GET") {
    return json(res, 200, {
      roles: [
        { id: ADMIN, name: "Super Admin" },
        { id: HR, name: "HR Manager" },
        { id: PAYROLL, name: "Payroll Manager" },
        { id: MANAGER, name: "Department Manager" },
        { id: EMPLOYEE, name: "Employee" },
      ],
    });
  }
  if (p === "/api/hrm/invitations" && method === "GET") {
    if (!requireRole(user, [ADMIN, HR], json, res)) return true;
    const rows =
      all(`SELECT i.id,i.email,i.name,i.title,i.department,i.location,i.role,i.expires_at,i.created_at,i.sent_at,i.email_status,i.used_at,
    u.id AS user_id,u.active AS user_active
    FROM invites i LEFT JOIN users u ON lower(u.email)=lower(i.email)
    WHERE i.company_id=? AND i.id=(SELECT i2.id FROM invites i2 WHERE i2.company_id=i.company_id AND lower(i2.email)=lower(i.email) ORDER BY COALESCE(NULLIF(i2.created_at,''),i2.expires_at) DESC,i2.rowid DESC LIMIT 1)
    ORDER BY COALESCE(NULLIF(i.created_at,''),i.expires_at) DESC`, user.company_id || "");
    const invitations = rows.map((x) => ({
      ...x,
      status: x.user_id
        ? x.user_active
          ? "Active"
          : "Disabled"
        : x.used_at
          ? "Active"
          : x.email_status === "revoked"
            ? "Invitation Revoked"
            : new Date(x.expires_at).getTime() <= Date.now()
              ? "Invitation Expired"
              : x.email_status === "sent"
                ? "Invitation Sent"
                : x.email_status === "failed"
                  ? "Delivery Failed"
                  : "Not Invited",
    }));
    return json(res, 200, { invitations });
  }
  if (p === "/api/documents" && method === "GET") {
    const canManage = isRole(user, [ADMIN, HR]);
    const rows = canManage
      ? all(
          "SELECT d.*,u.name AS author_name FROM documents d LEFT JOIN users u ON u.id=d.author_id WHERE d.company_id=? ORDER BY d.created_at DESC,d.version DESC",
          user.company_id || "",
        )
      : all(
          "SELECT d.id,d.title,d.category,d.body,d.published,d.author_id,d.company_id,d.created_at,d.description,d.original_filename,d.storage_key,d.mime_type,d.file_size,d.version,d.supersedes_id,d.updated_at FROM documents d WHERE d.company_id=? AND d.published=1 AND (d.storage_key<>'' OR NOT EXISTS(SELECT 1 FROM documents newer WHERE newer.company_id=d.company_id AND newer.supersedes_id=d.id AND newer.published=1)) ORDER BY d.created_at DESC,d.version DESC",
          user.company_id || "",
        );
    return json(res, 200, {
      documents: rows.map((d) => ({
        ...d,
        status: d.published
          ? "Published"
          : all("SELECT id FROM documents WHERE company_id=? AND supersedes_id=? LIMIT 1", user.company_id || "", d.id)
                .length
            ? "Replaced"
            : "Draft",
        legacy: !d.storage_key,
      })),
    });
  }
  if (p === "/api/documents" && method === "POST") {
    if (!requireRole(user, HR_ROLES, json, res)) return true;
    const d = await body(req),
      title = clean(d.title, 180),
      category = clean(d.category, 100) || "Company Policies",
      description = clean(d.description, 1000),
      filename = clean(d.filename, 200),
      mime = clean(d.mime_type, 100),
      encoded = clean(d.content_base64, 14_000_000);
    if (!title || !filename || !encoded)
      fail(400, "Add a title and select a PDF or DOCX file.");
    const ext = path.extname(filename).toLowerCase(),
      expected =
        ext === ".pdf"
          ? "application/pdf"
          : ext === ".docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : "";
    if (!expected || mime !== expected)
      fail(400, "Only PDF and DOCX documents are supported.");
    const bytes = Buffer.from(encoded, "base64");
    if (
      !bytes.length ||
      bytes.length > 10 * 1024 * 1024 ||
      bytes.toString("base64") !== encoded
    )
      fail(413, "The document must be a valid file up to 10 MB.");
    const valid =
      ext === ".pdf"
        ? bytes.subarray(0, 5).toString() === "%PDF-"
        : validDocx(bytes);
    if (!valid)
      fail(400, "The file contents do not match the selected document type.");
    const folder = path.join(dataDir, "private-documents");
    fs.mkdirSync(folder, { recursive: true });
    try {
      if (process.platform !== "win32") fs.chmodSync(folder, 0o700);
    } catch {}
    const latest = q(
      "SELECT id,version FROM documents WHERE company_id=? AND lower(title)=lower(?) AND category=? ORDER BY version DESC,created_at DESC LIMIT 1",
      user.company_id || "",
      title,
      category,
    );
    const storageKey = `${id()}${ext}`,
      target = path.join(folder, storageKey);
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    const docId = id();
    try {
      run(
        `INSERT INTO documents(id,title,category,body,published,author_id,created_at,description,original_filename,storage_key,mime_type,file_size,version,supersedes_id,updated_at,company_id) VALUES(?,?,?,'',0,?,?,?,?,?,?,?,?,?,?,?)`,
        docId,
        title,
        category,
        user.id,
        now(),
        description,
        filename,
        storageKey,
        expected,
        bytes.length,
        Number(latest?.version || 0) + 1,
        latest?.id || null,
        now(),
        user.company_id || "",
      );
      audit(
        user.id,
        "Uploaded policy document",
        "document",
        docId,
        `${title} v${Number(latest?.version || 0) + 1}`,
      );
    } catch (e) {
      try {
        fs.unlinkSync(target);
      } catch {}
      throw e;
    }
    return json(res, 201, {
      id: docId,
      version: Number(latest?.version || 0) + 1,
      status: "Draft",
    });
  }
  const docAction = p.match(
    /^\/api\/documents\/([\w-]+)\/(publish|unpublish|download|preview)$/,
  );
  if (docAction) {
    const [, docId, action] = docAction,
      doc = q("SELECT * FROM documents WHERE id=?", docId);
    if (!doc) fail(404, "Document not found.");
    if (user.role !== SUPER_ADMIN && String(doc.company_id || "") !== String(user.company_id || "")) fail(404, "Document not found.");
    if (["publish", "unpublish"].includes(action)) {
      if (method !== "PATCH")
        return json(res, 405, { error: "Method not allowed." });
      if (!requireRole(user, HR_ROLES, json, res)) return true;
      if (!doc.storage_key)
        fail(
          409,
          "This archived text policy cannot be published as an uploaded document. Upload the current PDF or DOCX as a new version.",
        );
      if (action === "publish") {
        run(
          "UPDATE documents SET published=0,updated_at=? WHERE company_id=? AND lower(title)=lower(?) AND category=? AND id<>?",
          now(),
          doc.company_id || "",
          doc.title,
          doc.category,
          doc.id,
        );
        run(
          "UPDATE documents SET published=1,updated_at=? WHERE id=?",
          now(),
          doc.id,
        );
        audit(
          user.id,
          "Published policy document",
          "document",
          doc.id,
          `${doc.title} v${doc.version}`,
        );
      } else {
        run(
          "UPDATE documents SET published=0,updated_at=? WHERE id=?",
          now(),
          doc.id,
        );
        audit(
          user.id,
          "Unpublished policy document",
          "document",
          doc.id,
          `${doc.title} v${doc.version}`,
        );
      }
      return json(res, 200, { ok: true });
    }
    if (method !== "GET")
      return json(res, 405, { error: "Method not allowed." });
    if (!doc.published && !isRole(user, HR_ROLES)) {
      json(res, 404, { error: "Document not found." });
      return true;
    }
    if (!doc.storage_key)
      fail(
        404,
        "This archived policy is available as text in the Documents page.",
      );
    if (action === "preview" && doc.mime_type !== "application/pdf")
      fail(
        415,
        "Only PDF files can be previewed. Download this DOCX file to open it.",
      );
    const safeKey = /^[a-f0-9-]{36}\.(pdf|docx)$/.test(doc.storage_key);
    if (!safeKey) fail(404, "Document file is unavailable.");
    const file = path.resolve(dataDir, "private-documents", doc.storage_key),
      root = path.resolve(dataDir, "private-documents") + path.sep;
    if (!file.startsWith(root) || !fs.existsSync(file))
      fail(404, "Document file is unavailable.");
    audit(
      user.id,
      action === "preview"
        ? "Previewed policy document"
        : "Downloaded policy document",
      "document",
      doc.id,
      `${doc.title} v${doc.version}`,
    );
    const ascii = doc.original_filename
      .replace(/[^\x20-\x7E]/g, "_")
      .replace(/["\\]/g, "_");
    res.writeHead(200, {
      "Content-Type": doc.mime_type,
      "Content-Length": String(fs.statSync(file).size),
      "Content-Disposition": `${action === "preview" ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.original_filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  if (p === "/api/hrm/salary" && method === "GET") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    const userId = clean(url.searchParams.get("user_id"), 80);
    if (!userId) fail(400, "Employee is required.");
    if (!sameCompany(user, userId)) fail(404, "Employee not found.");
    const rows = all(
      "SELECT s.*,u.name AS employee_name,u.email FROM salary_structures s JOIN users u ON u.id=s.user_id WHERE s.user_id=? ORDER BY effective_from DESC",
      userId,
    ).map((s) => ({
      ...s,
      allowances: parse(s.allowances_json, []),
      earnings: parse(s.earnings_json, []),
      deductions: parse(s.deductions_json, []),
    }));
    return json(res, 200, { structures: rows });
  }
  if (p === "/api/hrm/salary" && method === "POST") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    const d = await body(req),
      uid = clean(d.user_id, 80),
      effective = clean(d.effective_from, 10);
    if (!q("SELECT id FROM users WHERE id=? AND role='employee'", uid))
      fail(400, "Choose a valid employee.");
    if (!sameCompany(user, uid)) fail(404, "Employee not found.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effective))
      fail(400, "Choose a valid salary effective date.");
    const basic = amountPaise(d.basic_salary, "Basic salary");
    if (!basic) fail(400, "Monthly basic salary must be greater than zero.");
    const allowances = components(d.allowances, "Allowance"),
      earnings = components(d.earnings, "Other earning"),
      deductions = components(d.deductions, "Deduction"),
      method = ["calendar_days", "working_days"].includes(d.workday_method)
        ? d.workday_method
        : "working_days";
    const weekly = Array.isArray(d.weekly_offs)
      ? [...new Set(d.weekly_offs.map(Number))]
      : [0];
    if (weekly.some((x) => !Number.isInteger(x) || x < 0 || x > 6))
      fail(400, "Weekly-off days must be between Sunday (0) and Saturday (6).");
    const paidEntitlement =
      d.paid_leave_entitlement === "" || d.paid_leave_entitlement == null
        ? null
        : Number(d.paid_leave_entitlement);
    if (
      paidEntitlement !== null &&
      (!Number.isFinite(paidEntitlement) || paidEntitlement < 0)
    )
      fail(400, "Paid leave entitlement must be zero or more.");
    const sid = id();
    run(
      "INSERT INTO salary_structures(id,user_id,effective_from,currency,basic_paise,allowances_json,earnings_json,deductions_json,workday_method,weekly_offs_json,paid_leave_entitlement,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      sid,
      uid,
      effective,
      "INR",
      basic,
      JSON.stringify(allowances),
      JSON.stringify(earnings),
      JSON.stringify(deductions),
      method,
      JSON.stringify(weekly),
      paidEntitlement,
      user.id,
      now(),
    );
    audit(
      user.id,
      "Created salary structure",
      "salary_structure",
      sid,
      `${uid} · effective ${effective}`,
    );
    notify(
      uid,
      "Salary details updated",
      `A salary structure effective ${effective} was added to your employee record.`,
      "salary",
      sid,
    );
    return json(res, 201, { id: sid });
  }
  if (p === "/api/hrm/bank" && (method === "GET" || method === "PUT")) {
    const d = method === "PUT" ? await body(req) : null,
      uid = clean(url.searchParams.get("user_id") || d?.user_id || user.id, 80);
    if (!uid) fail(400, "Employee is required.");
    if (user.id !== uid && !isRole(user, PAYROLL_ROLES)) {
      json(res, 403, { error: "You can only access your own bank details." });
      return true;
    }
    if (method === "GET") {
      const row = q("SELECT * FROM bank_accounts WHERE user_id=?", uid);
      if (!row) return json(res, 200, { bank: null });
      const bank = parse(decryptText(row), {});
      return json(res, 200, {
        bank: {
          account_holder: bank.account_holder,
          bank_name: bank.bank_name,
          account_number_masked: bank.account_number
            ? `••••${bank.account_number.slice(-4)}`
            : "",
          ifsc: bank.ifsc,
        },
      });
    }
    const payload = {
      account_holder: clean(d.account_holder, 120),
      bank_name: clean(d.bank_name, 120),
      account_number: clean(d.account_number, 40),
      ifsc: clean(d.ifsc, 20).toUpperCase(),
    };
    if (
      !payload.account_holder ||
      !payload.bank_name ||
      !payload.account_number ||
      !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(payload.ifsc)
    )
      fail(
        400,
        "Enter account holder, bank, account number, and valid IFSC code.",
      );
    const enc = encryptText(JSON.stringify(payload));
    run(
      "INSERT INTO bank_accounts(user_id,ciphertext,iv,tag,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,tag=excluded.tag,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
      uid,
      enc.ciphertext,
      enc.iv,
      enc.tag,
      user.id,
      now(),
    );
    audit(user.id, "Updated encrypted bank details", "bank_account", uid);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/hrm/leave-types" && method === "GET") {
    const rows = all("SELECT * FROM leave_categories ORDER BY name");
    return json(res, 200, { categories: rows });
  }
  if (p === "/api/hrm/leave-types" && method === "PUT") {
    if (!requireRole(user, HR_ROLES, json, res)) return true;
    const d = await body(req),
      items = Array.isArray(d.categories) ? d.categories : [];
    if (items.length > 50) fail(400, "A maximum of 50 leave types is allowed.");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) {
        const name = clean(item.name, 100),
          category = item.category === "Unpaid" ? "Unpaid" : "Paid",
          ent = Number(item.entitlement_days || 0),
          monthly = Number(item.monthly_accrual_days || 0);
        if (
          !name ||
          !Number.isFinite(ent) ||
          ent < 0 ||
          !Number.isFinite(monthly) ||
          monthly < 0
        )
          fail(400, "Each leave type needs a name and a valid entitlement.");
        const exists = q("SELECT id FROM leave_categories WHERE name=?", name);
        if (exists)
          run(
            "UPDATE leave_categories SET category=?,entitlement_days=?,monthly_accrual_days=?,allow_half_day=?,exclude_non_working_days=?,excess_to_unpaid=?,notes=?,updated_by=?,updated_at=? WHERE id=?",
            category,
            ent,
            monthly,
            item.allow_half_day ? 1 : 0,
            item.exclude_non_working_days ? 1 : 0,
            item.excess_to_unpaid ? 1 : 0,
            clean(item.notes, 1000),
            user.id,
            now(),
            exists.id,
          );
        else
          run(
            "INSERT INTO leave_categories(id,name,category,entitlement_days,monthly_accrual_days,allow_half_day,exclude_non_working_days,excess_to_unpaid,notes,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            id(),
            name,
            category,
            ent,
            monthly,
            item.allow_half_day ? 1 : 0,
            item.exclude_non_working_days ? 1 : 0,
            item.excess_to_unpaid ? 1 : 0,
            clean(item.notes, 1000),
            user.id,
            now(),
          );
      }
      const keep = items.map((x) => clean(x.name, 100));
      if (keep.length) {
        const marks = keep.map(() => "?").join(",");
        db.prepare(
          `DELETE FROM leave_categories WHERE name NOT IN (${marks})`,
        ).run(...keep);
      } else db.exec("DELETE FROM leave_categories");
      audit(user.id, "Updated leave types and policy", "leave_categories");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return json(res, 200, {
      categories: all("SELECT * FROM leave_categories ORDER BY name"),
    });
  }
  if (p === "/api/hrm/leave-balances" && method === "GET") {
    const uid = clean(url.searchParams.get("user_id") || user.id, 80);
    if (uid !== user.id && !requireRole(user, [ADMIN, HR, MANAGER], json, res))
      return true;
    if (
      user.role === MANAGER &&
      q("SELECT department FROM employees WHERE user_id=?", uid)?.department !==
        q("SELECT department FROM employees WHERE user_id=?", user.id)
          ?.department
    ) {
      json(res, 403, {
        error: "Managers can only view leave balances in their department.",
      });
      return true;
    }
    const year =
      Number(url.searchParams.get("year")) || new Date().getFullYear();
    const structures = all(
        "SELECT * FROM salary_structures WHERE user_id=? AND effective_from<=? ORDER BY effective_from DESC",
        uid,
        `${year}-12-31`,
      ),
      weekly = structures[0] ? weeksFor(structures[0]) : new Set([0]),
      categories = all("SELECT * FROM leave_categories ORDER BY name"),
      rows = approvedLeaveRows(uid, year),
      used = {};
    for (const row of rows) {
      const catName = requestType(row),
        cat = categories.find((x) => x.name === catName);
      if (cat)
        used[catName] =
          (used[catName] || 0) +
          leaveUnits(
            row,
            weekly,
            fetchHolidays(row.start_date, row.end_date || row.start_date, user.company_id || ""),
          );
    }
    return json(res, 200, {
      year,
      balances: categories.map((c) => ({
        name: c.name,
        category: c.category,
        entitlement: Number(c.monthly_accrual_days)
          ? Math.min(
              Number(c.entitlement_days),
              Number(c.monthly_accrual_days) *
                (year === new Date().getFullYear()
                  ? new Date().getMonth() + 1
                  : 12),
            )
          : Number(c.entitlement_days),
        used: used[c.name] || 0,
        remaining: Math.max(
          0,
          (Number(c.monthly_accrual_days)
            ? Math.min(
                Number(c.entitlement_days),
                Number(c.monthly_accrual_days) *
                  (year === new Date().getFullYear()
                    ? new Date().getMonth() + 1
                    : 12),
              )
            : Number(c.entitlement_days)) - (used[c.name] || 0),
        ),
      })),
    });
  }
  if (p === "/api/hrm/notifications" && method === "GET")
    return json(res, 200, {
      notifications: all(
        "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
        user.id,
      ),
      unread: Number(
        q(
          "SELECT count(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL",
          user.id,
        ).n,
      ),
    });
  const notificationMatch = p.match(
    /^\/api\/hrm\/notifications\/([\w-]+)\/read$/,
  );
  if (notificationMatch && method === "POST") {
    const n = q(
      "SELECT id FROM notifications WHERE id=? AND user_id=?",
      notificationMatch[1],
      user.id,
    );
    if (!n) fail(404, "Notification not found.");
    run("UPDATE notifications SET read_at=? WHERE id=?", now(), n.id);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/hrm/tasks" && method === "GET") {
    if (!requireRole(user, [ADMIN, HR, MANAGER, EMPLOYEE], json, res))
      return true;
    const taskScope = companyWhere(user, "u");
    const rows = isRole(user, [EMPLOYEE])
      ? all(
          "SELECT t.*,u.name AS assigned_by_name FROM tasks t JOIN users u ON u.id=t.created_by WHERE t.user_id=? ORDER BY COALESCE(t.due_date,'9999-12-31'),t.created_at DESC",
          user.id,
        )
      : isRole(user, [MANAGER])
        ? all(
          `SELECT t.*,u.name AS employee_name,c.name AS assigned_by_name FROM tasks t JOIN users u ON u.id=t.user_id JOIN employees e ON e.user_id=u.id JOIN users c ON c.id=t.created_by WHERE e.department=(SELECT department FROM employees WHERE user_id=?) AND ${taskScope.sql} ORDER BY COALESCE(t.due_date,'9999-12-31'),t.created_at DESC`,
            user.id,
          ...taskScope.args,
          )
        : all(
            `SELECT t.*,u.name AS employee_name,c.name AS assigned_by_name FROM tasks t JOIN users u ON u.id=t.user_id JOIN users c ON c.id=t.created_by WHERE ${taskScope.sql} ORDER BY COALESCE(t.due_date,'9999-12-31'),t.created_at DESC`,
            ...taskScope.args,
          );
    return json(res, 200, {
      tasks: rows.map((t) => ({
        ...t,
        subtasks: all(
          "SELECT * FROM task_subtasks WHERE task_id=? ORDER BY sort_order",
          t.id,
        ),
        comments: all(
          "SELECT c.*,u.name FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.created_at",
          t.id,
        ),
      })),
    });
  }
  if (p === "/api/hrm/tasks" && method === "POST") {
    if (!requireRole(user, [ADMIN, HR, MANAGER, EMPLOYEE], json, res))
      return true;
    const d = await body(req);
    let assignee = isRole(user, [EMPLOYEE]) ? user.id : clean(d.user_id, 80);
    if (!assignee) assignee = user.id;
    const employee = q(
      "SELECT u.id,e.department FROM users u JOIN employees e ON e.user_id=u.id WHERE u.id=? AND u.role='employee' AND u.active=1",
      assignee,
    );
    if (!employee) fail(400, "Choose an active employee.");
    if (!requireCompanyUser(user, assignee, json, res)) return true;
    if (
      user.role === MANAGER &&
      employee.department !==
        q("SELECT department FROM employees WHERE user_id=?", user.id)
          ?.department
    ) {
      json(res, 403, {
        error: "Managers can only assign tasks within their department.",
      });
      return true;
    }
    if (isRole(user, [EMPLOYEE]) && assignee !== user.id) {
      json(res, 403, {
        error: "Employees can only create tasks for themselves.",
      });
      return true;
    }
    const title = clean(d.title, 180),
      priority = ["Low", "Medium", "High", "Urgent"].includes(d.priority)
        ? d.priority
        : "Medium",
      due = clean(d.due_date, 10),
      start = clean(d.start_date, 10),
      estimate = Number(d.estimate_hours || 0);
    if (!title) fail(400, "Task title is required.");
    if (estimate < 0 || !Number.isFinite(estimate))
      fail(400, "Estimated hours must be zero or more.");
    if (due && start && due < start)
      fail(400, "Due date cannot be before the start date.");
    const tid = id();
    const initialStatus = isRole(user, [EMPLOYEE]) ? "In Progress" : "Assigned";
    run(
      "INSERT INTO tasks(id,user_id,title,due_date,status,created_by,created_at,updated_at,description,priority,start_date,estimate_hours,category,project,attachment_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      tid,
      assignee,
      title,
      due,
      initialStatus,
      user.id,
      now(),
      now(),
      clean(d.description, 5000),
      priority,
      start,
      estimate,
      clean(d.category, 100),
      clean(d.project, 120),
      clean(d.attachment_url, 1000),
    );
    run(
      "INSERT INTO task_history VALUES(?,?,?,?,?,?)",
      id(),
      tid,
      user.id,
      isRole(user, [EMPLOYEE]) ? "Created" : "Assigned",
      isRole(user, [EMPLOYEE])
        ? "Self-assigned task"
        : `Assigned to ${assignee}`,
      now(),
    );
    for (const [i, sub] of (Array.isArray(d.subtasks)
      ? d.subtasks
      : []
    ).entries()) {
      const subTitle = clean(sub, 180);
      if (subTitle)
        run(
          "INSERT INTO task_subtasks(id,task_id,title,sort_order,created_at) VALUES(?,?,?,?,?)",
          id(),
          tid,
          subTitle,
          i,
          now(),
        );
    }
    audit(
      user.id,
      isRole(user, [EMPLOYEE]) ? "Created task" : "Assigned task",
      "task",
      tid,
      title,
    );
    if (assignee !== user.id)
      notify(assignee, "New task assigned", title, "task", tid);
    return json(res, 201, { id: tid });
  }
  const taskSubMatch = p.match(
    /^\/api\/hrm\/tasks\/([\w-]+)(?:\/(comments|review|subtasks))?$/,
  );
  if (taskSubMatch && method === "PATCH" && taskSubMatch[2] === undefined) {
    const task = q("SELECT * FROM tasks WHERE id=?", taskSubMatch[1]);
    if (!task) fail(404, "Task not found.");
    if (!sameCompany(user, task.user_id)) fail(404, "Task not found.");
    if (
      user.role === MANAGER &&
      q("SELECT department FROM employees WHERE user_id=?", task.user_id)
        ?.department !==
        q("SELECT department FROM employees WHERE user_id=?", user.id)
          ?.department
    ) {
      json(res, 403, {
        error: "Managers can only review tasks within their department.",
      });
      return true;
    }
    const d = await body(req),
      manager = isRole(user, TASK_ROLES) && user.id !== task.user_id,
      owner = user.id === task.user_id;
    if (!owner && !manager) {
      json(res, 403, { error: "This task is not assigned to you." });
      return true;
    }
    const status = clean(d.status, 30);
    const employeeTransitions = {
      Assigned: ["Accepted", "Blocked"],
      Accepted: ["In Progress", "Blocked"],
      "In Progress": ["Pending Review", "Blocked"],
      Blocked: ["In Progress"],
      Reopened: ["In Progress"],
    };
    if (owner) {
      if (!employeeTransitions[task.status]?.includes(status))
        fail(400, `You cannot move a task from ${task.status} to ${status}.`);
      run(
        "UPDATE tasks SET status=?,updated_at=?,accepted_at=CASE WHEN ?='Accepted' THEN ? ELSE accepted_at END,completed_at=NULL WHERE id=?",
        status,
        now(),
        status,
        now(),
        task.id,
      );
    } else {
      if (
        !["Completed", "Reopened", "In Progress"].includes(status) ||
        !["Pending Review", "Blocked", "Completed", "Reopened"].includes(
          task.status,
        )
      )
        fail(400, "Invalid task review decision.");
      run(
        "UPDATE tasks SET status=?,review_feedback=?,updated_at=?,completed_at=CASE WHEN ?='Completed' THEN ? ELSE NULL END WHERE id=?",
        status,
        clean(d.feedback, 2000),
        now(),
        status,
        now(),
        task.id,
      );
    }
    run(
      "INSERT INTO task_history VALUES(?,?,?,?,?,?)",
      id(),
      task.id,
      user.id,
      owner ? "Status changed" : "Task reviewed",
      `${task.status} → ${status}${d.feedback ? `: ${clean(d.feedback, 300)}` : ""}`,
      now(),
    );
    audit(
      user.id,
      owner ? "Updated task status" : "Reviewed task",
      "task",
      task.id,
      status,
    );
    notify(
      owner ? task.created_by : task.user_id,
      owner ? "Task status updated" : "Task review update",
      `${task.title}: ${status}${d.feedback ? ` — ${clean(d.feedback, 500)}` : ""}`,
      "task",
      task.id,
    );
    return json(res, 200, { ok: true });
  }
  if (taskSubMatch && taskSubMatch[2] === "comments" && method === "POST") {
    const task = q("SELECT * FROM tasks WHERE id=?", taskSubMatch[1]);
    if (!task) fail(404, "Task not found.");
    if (!sameCompany(user, task.user_id)) fail(404, "Task not found.");
    if (
      user.role === MANAGER &&
      q("SELECT department FROM employees WHERE user_id=?", task.user_id)
        ?.department !==
        q("SELECT department FROM employees WHERE user_id=?", user.id)
          ?.department
    ) {
      json(res, 403, {
        error: "Managers can only comment on tasks within their department.",
      });
      return true;
    }
    if (task.user_id !== user.id && !isRole(user, TASK_ROLES)) {
      json(res, 403, { error: "You cannot comment on this task." });
      return true;
    }
    const d = await body(req),
      text = clean(d.body, 3000);
    if (!text) fail(400, "Comment cannot be empty.");
    const cid = id();
    run(
      "INSERT INTO task_comments VALUES(?,?,?,?,?)",
      cid,
      task.id,
      user.id,
      text,
      now(),
    );
    run(
      "INSERT INTO task_history VALUES(?,?,?,?,?,?)",
      id(),
      task.id,
      user.id,
      "Comment added",
      text.slice(0, 500),
      now(),
    );
    notify(
      task.user_id === user.id ? task.created_by : task.user_id,
      "Task comment added",
      `${task.title}: ${text.slice(0, 300)}`,
      "task",
      task.id,
    );
    return json(res, 201, { id: cid });
  }
  if (taskSubMatch && taskSubMatch[2] === "subtasks" && method === "POST") {
    if (!requireRole(user, TASK_ROLES, json, res)) return true;
    const task = q("SELECT * FROM tasks WHERE id=?", taskSubMatch[1]);
    if (!task) fail(404, "Task not found.");
    if (!sameCompany(user, task.user_id)) fail(404, "Task not found.");
    if (
      user.role === MANAGER &&
      q(
        "SELECT department FROM employees WHERE user_id=?",
        (q("SELECT user_id FROM tasks WHERE id=?", task.id) || {}).user_id,
      )?.department !==
        q("SELECT department FROM employees WHERE user_id=?", user.id)
          ?.department
    ) {
      json(res, 403, {
        error: "Managers can only update tasks in their department.",
      });
      return true;
    }
    const d = await body(req),
      title = clean(d.title, 180);
    if (!title) fail(400, "Checklist item is required.");
    const sid = id();
    run(
      "INSERT INTO task_subtasks(id,task_id,title,sort_order,created_at) VALUES(?,?,?,?,?)",
      sid,
      task.id,
      title,
      Number(
        q("SELECT count(*) n FROM task_subtasks WHERE task_id=?", task.id).n,
      ),
      now(),
    );
    return json(res, 201, { id: sid });
  }
  if (
    p.match(/^\/api\/hrm\/tasks\/[\w-]+\/subtasks\/[\w-]+$/) &&
    method === "PATCH"
  ) {
    const [, tid, , sid] = p.match(
      /^\/api\/hrm\/tasks\/([\w-]+)\/(subtasks)\/([\w-]+)$/,
    );
    const task = q("SELECT * FROM tasks WHERE id=?", tid),
      sub = q("SELECT * FROM task_subtasks WHERE id=? AND task_id=?", sid, tid);
    if (!task || !sub) fail(404, "Task checklist item not found.");
    if (!sameCompany(user, task.user_id)) fail(404, "Task checklist item not found.");
    if (
      user.role === MANAGER &&
      q("SELECT department FROM employees WHERE user_id=?", task.user_id)
        ?.department !==
        q("SELECT department FROM employees WHERE user_id=?", user.id)
          ?.department
    ) {
      json(res, 403, {
        error: "Managers can only access tasks in their department.",
      });
      return true;
    }
    if (task.user_id !== user.id && !isRole(user, TASK_ROLES)) {
      json(res, 403, { error: "This task is not assigned to you." });
      return true;
    }
    const completed = !!(await body(req)).completed;
    run(
      "UPDATE task_subtasks SET status=?,completed_at=? WHERE id=?",
      completed ? "Done" : "Open",
      completed ? now() : null,
      sid,
    );
    return json(res, 200, { ok: true });
  }
  if (p === "/api/requests" && (method === "GET" || method === "POST")) {
    if (method === "GET") {
      const rows = isRole(user, [ADMIN, HR, MANAGER])
        ? isRole(user, [MANAGER])
          ? all(
              `SELECT r.*,u.name FROM requests r JOIN users u ON u.id=r.user_id JOIN employees e ON e.user_id=u.id WHERE e.department=(SELECT department FROM employees WHERE user_id=?) AND ${companyWhere(user,"u").sql} ORDER BY r.created_at DESC`,
              user.id, ...companyWhere(user,"u").args,
            )
          : all(
              `SELECT r.*,u.name FROM requests r JOIN users u ON u.id=r.user_id WHERE ${companyWhere(user,"u").sql} ORDER BY r.created_at DESC`,
              ...companyWhere(user,"u").args,
            )
        : all(
            "SELECT * FROM requests WHERE user_id=? ORDER BY created_at DESC",
            user.id,
          );
      return json(res, 200, { requests: rows });
    }
    const d = await body(req),
      kind = clean(d.kind, 40),
      details = clean(d.details, 2000),
      leaveType = clean(d.leave_type, 100),
      start = clean(d.start_date, 10),
      end = clean(d.end_date, 10);
    if (!kind || !details) fail(400, "Request type and details are required.");
    if (
      kind === "Leave" &&
      !q("SELECT id FROM leave_categories WHERE name=?", leaveType)
    )
      fail(400, "Choose a configured leave type.");
    if (
      kind === "Leave" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    )
      fail(400, "Leave requests need valid start and end dates.");
    if (start && end && end < start)
      fail(400, "End date must not be before start date.");
    const requestedDays =
      kind === "Leave"
        ? workdays(start, end, new Set([0, 6]), fetchHolidays(start, end, user.company_id || ""))
            .length
        : Number(d.days) || null;
    if (kind === "Leave" && !requestedDays)
      fail(
        400,
        "The selected dates contain no eligible leave days after weekends and configured holidays are excluded.",
      );
    const rid = id();
    run(
      "INSERT INTO requests(id,user_id,kind,details,start_date,end_date,days,status,decision_note,created_by,created_at,decided_at,leave_type) VALUES(?,?,?,?,?,?,?,'Pending','',?,?,NULL,?)",
      rid,
      user.id,
      kind,
      details,
      start || null,
      end || null,
      requestedDays,
      user.id,
      now(),
      kind === "Leave" ? leaveType : "",
    );
    audit(user.id, "Submitted request", "request", rid, kind);
    notifyRole(
      HR,
      "Employee request submitted",
      `${user.name} submitted ${kind}${leaveType ? ` (${leaveType})` : ""}.`,
      "request",
      rid,
      user.company_id || "",
    );
    notifyRole(
      ADMIN,
      "Employee request submitted",
      `${user.name} submitted ${kind}${leaveType ? ` (${leaveType})` : ""}.`,
      "request",
      rid,
      user.company_id || "",
    );
    return json(res, 201, {
      request: q("SELECT * FROM requests WHERE id=?", rid),
    });
  }
  const decision = p.match(/^\/api\/requests\/([\w-]+)\/decision$/);
  if (decision && method === "POST") {
    if (!requireRole(user, [ADMIN], json, res)) return true;
    const d = await body(req),
      status = d.status;
    if (!["Approved", "Rejected"].includes(status))
      fail(400, "Decision must be Approved or Rejected.");
    const row = q("SELECT * FROM requests WHERE id=?", decision[1]);
    if (!row) fail(404, "Request not found.");
    if (!sameCompany(user, row.user_id)) fail(404, "Request not found.");
    if (row.status !== "Pending")
      fail(409, "This request has already been decided.");
    const payrollLeaveStatus = ["Paid", "Unpaid"].includes(d.payroll_leave_status)
      ? d.payroll_leave_status
      : "";
    if (status === "Approved" && row.kind === "Leave" && !payrollLeaveStatus)
      fail(400, "Choose whether approved leave is Paid or Unpaid for payroll.");
    run(
      "UPDATE requests SET status=?,decision_note=?,payroll_leave_status=CASE WHEN ?='Approved' AND kind='Leave' THEN ? ELSE payroll_leave_status END,decided_by=?,decided_at=? WHERE id=?",
      status,
      clean(d.note, 1000),
      status,
      payrollLeaveStatus,
      user.id,
      now(),
      row.id,
    );
    if (status === "Approved" && row.kind === "Leave" && row.start_date) {
      const employee = q("SELECT name FROM users WHERE id=?", row.user_id);
      run(
        "INSERT INTO calendar_events(id,title,start_date,end_date,kind,description,approved,created_by,created_at,company_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        id(),
        `Approved leave · ${employee?.name || "Employee"}`,
        row.start_date,
        row.end_date || row.start_date,
        "leave",
        row.details,
        1,
        user.id,
        now(),
        user.company_id || "",
      );
      recalcDraftsForUser(row.user_id, user.id, row.start_date);
    }
    audit(user.id, `${status} request`, "request", row.id);
    notify(
      row.user_id,
      `Leave request ${status.toLowerCase()}`,
      `${row.leave_type || row.kind}: ${status}${d.note ? ` — ${clean(d.note, 500)}` : ""}`,
      "request",
      row.id,
    );
    return json(res, 200, { ok: true });
  }
  if (p === "/api/attendance/action" && method === "POST") {
    const d = await body(req),
      action = clean(d.action, 20),
      zone = process.env.APP_TIMEZONE || "Asia/Kolkata",
      date = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
      clockParts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: zone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .formatToParts(new Date())
          .map((x) => [x.type, x.value]),
      ),
      clockMinute = Number(clockParts.hour) * 60 + Number(clockParts.minute);
    let record = q(
        "SELECT * FROM attendance WHERE user_id=? AND work_date=?",
        user.id,
        date,
      ),
      segments = record ? parse(record.segments, []) : [];
    if (action === "in") {
      if (record) fail(409, "A shift is already recorded for today.");
      segments.push({ start: now(), end: null });
      run(
        "INSERT INTO attendance(id,user_id,work_date,segments,status) VALUES(?,?,?,?,?)",
        id(),
        user.id,
        date,
        JSON.stringify(segments),
        "in",
      );
    } else if (action === "resume") {
      if (!record || record.status !== "out")
        fail(409, "There is no paused shift to resume.");
      segments.push({ start: now(), end: null });
      run(
        "UPDATE attendance SET segments=?,status='in' WHERE id=?",
        JSON.stringify(segments),
        record.id,
      );
    } else if (action === "out") {
      if (!record || record.status !== "in")
        fail(409, "You are not currently clocked in.");
      if (clockMinute < 1140 && !clean(d.reason, 500))
        fail(400, "A reason is required to clock out before 7:00 PM.");
      segments[segments.length - 1].end = now();
      run(
        "UPDATE attendance SET segments=?,status='out' WHERE id=?",
        JSON.stringify(segments),
        record.id,
      );
    } else fail(400, "Unknown attendance action.");
    const label =
        action === "in"
          ? "Clocked in"
          : action === "out"
            ? "Clocked out"
            : "Resumed shift",
      late = Math.max(0, clockMinute - 610),
      details =
        action === "in" && late
          ? `Clock-in · ${late} min late after 10-minute grace`
          : action === "out"
            ? clean(d.reason, 500) || "Shift activity"
            : clean(d.reason, 500) || "Shift resumed";
    run(
      "INSERT INTO activity_logs VALUES(?,?,?,?,?,?)",
      id(),
      user.id,
      user.id,
      label,
      details,
      now(),
    );
    audit(user.id, label, "attendance", user.id, date);
    recalcDraftsForUser(user.id, user.id, date);
    return json(res, 200, {
      attendance: q(
        "SELECT * FROM attendance WHERE user_id=? AND work_date=?",
        user.id,
        date,
      ),
    });
  }
  if (p === "/api/hrm/attendance/correction" && method === "POST") {
    if (!requireRole(user, [ADMIN], json, res)) return true;
    const d = await body(req),
      userId = clean(d.user_id, 80),
      workDate = clean(d.work_date, 10),
      status = clean(d.admin_status, 20),
      clockIn = clean(d.clock_in, 5),
      clockOut = clean(d.clock_out, 5),
      note = clean(d.admin_note, 1000);
    if (!q("SELECT id FROM users WHERE id=? AND role='employee'", userId))
      fail(404, "Choose a valid employee.");
    if (!sameCompany(user, userId)) fail(404, "Choose a valid employee.");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(workDate) ||
      parseDate(workDate) === null ||
      new Date(parseDate(workDate)).toISOString().slice(0, 10) !== workDate
    )
      fail(400, "Choose a valid attendance date.");
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    if (workDate > today)
      fail(400, "Attendance can only be updated for today or an earlier date.");
    const periodStatus = q(
      "SELECT status FROM payroll_periods WHERE period=? AND company_id=?",
      workDate.slice(0, 7),
      user.company_id || "",
    )?.status;
    if (periodStatus && !["Draft", "Validation"].includes(periodStatus))
      fail(
        409,
        "This month’s payroll is already in approval or closed. Use an Admin payroll adjustment for changes to a locked period.",
      );
    if (!["present", "half_day", "absent"].includes(status))
      fail(400, "Choose Present, Half day, or Absent.");
    const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (Boolean(clockIn) !== Boolean(clockOut))
      fail(
        400,
        "Enter both clock-in and clock-out times, or leave both blank.",
      );
    if (
      clockIn &&
      (!validTime(clockIn) || !validTime(clockOut) || clockOut <= clockIn)
    )
      fail(400, "Enter valid times with clock-out after clock-in.");
    const previous = q(
        "SELECT * FROM attendance WHERE user_id=? AND work_date=?",
        userId,
        workDate,
      ),
      segments = previous ? parse(previous.segments, []) : [];
    if (clockIn) {
      const toIso = (time) =>
        new Date(workDate + "T" + time + ":00+05:30").toISOString();
      segments.splice(0, segments.length, {
        start: toIso(clockIn),
        end: toIso(clockOut),
      });
    }
    const attendanceId = previous?.id || id(),
      updatedAt = now();
    run(
      "INSERT INTO attendance(id,user_id,work_date,segments,status,admin_status,admin_note,admin_updated_by,admin_updated_at) VALUES(?,?,?,?,'out',?,?,?,?) ON CONFLICT(user_id,work_date) DO UPDATE SET segments=excluded.segments,status='out',admin_status=excluded.admin_status,admin_note=excluded.admin_note,admin_updated_by=excluded.admin_updated_by,admin_updated_at=excluded.admin_updated_at",
      attendanceId,
      userId,
      workDate,
      JSON.stringify(segments),
      status,
      note,
      user.id,
      updatedAt,
    );
    const label =
        status === "half_day"
          ? "Half day"
          : status[0].toUpperCase() + status.slice(1),
      detail =
        "Admin marked " +
        label +
        (clockIn ? " · " + clockIn + "–" + clockOut : "") +
        (note ? " · " + note : "");
    audit(
      user.id,
      "Updated employee attendance",
      "attendance",
      attendanceId,
      workDate + " · " + detail,
    );
    run(
      "INSERT INTO activity_logs VALUES(?,?,?,?,?,?)",
      id(),
      user.id,
      userId,
      "Attendance updated",
      detail,
      updatedAt,
    );
    notify(
      userId,
      "Attendance updated",
      "Your attendance for " +
        workDate +
        " was updated by Admin: " +
        label +
        ".",
      "attendance",
      attendanceId,
    );
    recalcDraftsForUser(userId, user.id, workDate);
    return json(res, 200, {
      attendance: q("SELECT * FROM attendance WHERE id=?", attendanceId),
    });
  }
  if (p === "/api/hrm/attendance" && method === "GET") {
    if (!requireRole(user, [ADMIN, HR, MANAGER], json, res)) return true;
    const rows = isRole(user, [MANAGER])
      ? all(
          "SELECT a.*,u.name FROM attendance a JOIN users u ON u.id=a.user_id JOIN employees e ON e.user_id=u.id WHERE e.department=(SELECT department FROM employees WHERE user_id=?) ORDER BY work_date DESC LIMIT 500",
          user.id,
        )
      : all(
          "SELECT a.*,u.name FROM attendance a JOIN users u ON u.id=a.user_id WHERE u.role='employee' ORDER BY work_date DESC LIMIT 500",
        );
    const logs = isRole(user, [MANAGER])
      ? all(
          "SELECT l.*,u.name FROM activity_logs l JOIN users u ON u.id=l.user_id JOIN employees e ON e.user_id=u.id WHERE e.department=(SELECT department FROM employees WHERE user_id=?) ORDER BY l.created_at DESC LIMIT 500",
          user.id,
        )
      : all(
          "SELECT l.*,u.name FROM activity_logs l JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 500",
        );
    return json(res, 200, { attendance: rows, logs });
  }
  if (p === "/api/hrm/payroll" && method === "GET") {
    const queryPeriod = url.searchParams.get("period");
    if (isRole(user, EMPLOYEE)) {
      const rows = all(
        "SELECT i.*,p.period,p.status AS period_status,p.published_at,p.paid_at,u.name,u.email FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id JOIN users u ON u.id=i.user_id WHERE i.user_id=? AND p.status IN ('Published','Paid') ORDER BY p.period DESC",
        user.id,
      );
      return json(res, 200, {
        periods: rows.map((r) => ({
          ...r,
          allowances: parse(r.allowances_json, []),
          earnings: parse(r.earnings_json, []),
          other_deductions: parse(r.other_deductions_json, []),
          calculation: parse(r.calculation_json, {}),
          validation: [],
        })),
      });
    }
    if (!requireRole(user, [ADMIN, HR, PAYROLL], json, res)) return true;
    const periods = queryPeriod
      ? all(
          "SELECT * FROM payroll_periods WHERE period=? AND company_id=? ORDER BY period DESC",
          cleanPeriod(queryPeriod),
          user.company_id || "",
        )
      : all("SELECT * FROM payroll_periods WHERE company_id=? ORDER BY period DESC LIMIT 36", user.company_id || "");
    return json(res, 200, {
      periods: periods.map((row) => ({
        ...row,
        validation: parse(row.validation_json, []),
        item_count: Number(
          q("SELECT count(*) n FROM payroll_items WHERE period_id=?", row.id).n,
        ),
        gross_paise: Number(
          q(
            "SELECT COALESCE(sum(gross_paise),0) total FROM payroll_items WHERE period_id=?",
            row.id,
          ).total,
        ),
        net_paise: Number(
          q(
            "SELECT COALESCE(sum(net_paise),0) total FROM payroll_items WHERE period_id=?",
            row.id,
          ).total,
        ),
      })),
    });
  }
  if (p === "/api/hrm/payroll/generate" && method === "POST") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    const d = await body(req),
      period = cleanPeriod(d.period),
      companyId = user.company_id || "",
      existing = q("SELECT * FROM payroll_periods WHERE period=? AND company_id=?", period, companyId);
    if (existing) {
      json(res, 409, {
        error:
          "Payroll already exists for this period. Reopen a draft for recalculation or choose another month.",
        period_id: existing.id,
      });
      return true;
    }
    const month = monthBounds(period);
    const periodStart = d.period_start_date || month.start;
    const periodEnd = d.period_end_date || month.end;
    if (!parseDate(periodStart) || !parseDate(periodEnd) || periodStart < month.start || periodEnd > month.end || periodStart > periodEnd)
      return json(res, 400, { error: "Payroll start and end dates must form a valid range within the selected month." });
    const periodId = id();
    run(
      "INSERT INTO payroll_periods(id,company_id,period,period_start_date,period_end_date,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'Draft',?,?,?)",
      periodId,
      companyId,
      period,
      periodStart,
      periodEnd,
      user.id,
      now(),
      now(),
    );
    recalcPeriod(periodId, user.id);
    return json(res, 201, {
      period: serializePeriod(
        q("SELECT * FROM payroll_periods WHERE id=?", periodId),
      ),
    });
  }
  const periodMatch = p.match(/^\/api\/hrm\/payroll\/periods\/([\w-]+)$/);
  if (periodMatch && method === "GET") {
    const period = q(
      "SELECT * FROM payroll_periods WHERE id=?",
      periodMatch[1],
    );
    if (!period) fail(404, "Payroll period not found.");
    if (!requireRole(user, [ADMIN, HR, PAYROLL], json, res)) return true;
    if (user.role !== SUPER_ADMIN && String(period.company_id || "") !== String(user.company_id || "")) fail(404, "Payroll period not found.");
    return json(res, 200, { period: serializePeriod(period) });
  }
  const recalcMatch = p.match(
    /^\/api\/hrm\/payroll\/periods\/([\w-]+)\/recalculate$/,
  );
  if (recalcMatch && method === "POST") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    const period = q(
      "SELECT * FROM payroll_periods WHERE id=?",
      recalcMatch[1],
    );
    if (!period) fail(404, "Payroll period not found.");
    if (user.role !== SUPER_ADMIN && String(period.company_id || "") !== String(user.company_id || "")) fail(404, "Payroll period not found.");
    if (!recalcPeriod(period.id, user.id))
      fail(409, "Only draft or validation-stage payroll can be recalculated.");
    return json(res, 200, {
      period: serializePeriod(
        q("SELECT * FROM payroll_periods WHERE id=?", period.id),
      ),
    });
  }
  const transition = p.match(
    /^\/api\/hrm\/payroll\/periods\/([\w-]+)\/transition$/,
  );
  if (transition && method === "POST") {
    const period = q("SELECT * FROM payroll_periods WHERE id=?", transition[1]);
    if (!period) fail(404, "Payroll period not found.");
    if (user.role !== SUPER_ADMIN && String(period.company_id || "") !== String(user.company_id || "")) fail(404, "Payroll period not found.");
    const d = await body(req),
      to = clean(d.to, 30),
      note = clean(d.note, 1000);
    const allowed = {
      Validation: "HR Review",
      "HR Review": "Payroll Approval",
      "Payroll Approval": "Finalized",
      Finalized: "Published",
    };
    if (allowed[period.status] !== to)
      fail(409, `Cannot move payroll from ${period.status} to ${to}.`);
    if (
      ["Validation", "HR Review"].includes(period.status) &&
      !requireRole(user, [ADMIN, HR], json, res)
    )
      return true;
    if (
      ["Payroll Approval", "Finalized"].includes(period.status) &&
      !requireRole(user, PAYROLL_ROLES, json, res)
    )
      return true;
    if (
      ["HR Review", "Payroll Approval", "Finalized"].includes(to) &&
      period.created_by === user.id
    )
      fail(403, "A different authorized user must review and approve payroll.");
    if (to === "Payroll Approval" && period.hr_reviewer === user.id)
      fail(403, "Payroll approver must be different from the HR reviewer.");
    const errors = all(
      "SELECT validation_json FROM payroll_items WHERE period_id=?",
      period.id,
    )
      .flatMap((x) => parse(x.validation_json, []))
      .concat(parse(period.validation_json, []));
    if (to === "HR Review" && errors.some((x) => x.level === "error"))
      fail(409, "Resolve payroll validation errors before HR review.");
    const updates = {};
    if (to === "HR Review") updates.hr_reviewer = user.id;
    if (to === "Finalized") {
      updates.finalized_by = user.id;
      updates.payroll_approver = user.id;
    }
    if (to === "Published") updates.published_at = now();
    const sets = ["status=?", "updated_at=?"],
      args = [to, now()];
    for (const [k, v] of Object.entries(updates)) {
      sets.push(`${k}=?`);
      args.push(v);
    }
    args.push(period.id);
    run(`UPDATE payroll_periods SET ${sets.join(",")} WHERE id=?`, ...args);
    run(
      "UPDATE payroll_items SET updated_at=? WHERE period_id=?",
      now(),
      period.id,
    );
    run(
      "INSERT INTO payroll_approvals VALUES(?,?,?,?,?,?,?)",
      id(),
      period.id,
      to,
      user.id,
      to,
      note,
      now(),
    );
    audit(user.id, `Payroll moved to ${to}`, "payroll_period", period.id, note);
    if (to === "HR Review")
      for (const row of all(
        "SELECT id FROM users WHERE role IN ('hr_manager','admin') AND active=1 AND id<>? AND COALESCE(company_id,'')=?",
        user.id, period.company_id || "",
      ))
        notify(
          row.id,
          "Payroll ready for HR review",
          `Payroll for ${period.period} is ready for validation.`,
          "payroll",
          period.id,
        );
    if (to === "Payroll Approval")
      for (const row of all(
        "SELECT id FROM users WHERE role IN ('payroll_manager','admin') AND active=1 AND id<>? AND COALESCE(company_id,'')=?",
        user.id, period.company_id || "",
      ))
        notify(
          row.id,
          "Payroll approval required",
          `Payroll for ${period.period} passed HR review.`,
          "payroll",
          period.id,
        );
    if (to === "Published") {
      for (const item of all(
        "SELECT user_id FROM payroll_items WHERE period_id=?",
        period.id,
      ))
        notify(
          item.user_id,
          "Payslip published",
          `Your ${period.period} payslip is available.`,
          "payroll",
          period.id,
        );
    }
    return json(res, 200, {
      period: serializePeriod(
        q("SELECT * FROM payroll_periods WHERE id=?", period.id),
      ),
    });
  }
  const payment = p.match(/^\/api\/hrm\/payroll\/periods\/([\w-]+)\/paid$/);
  if (payment && method === "POST") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    const period = q("SELECT * FROM payroll_periods WHERE id=?", payment[1]);
    if (!period) fail(404, "Payroll period not found.");
    if (user.role !== SUPER_ADMIN && String(period.company_id || "") !== String(user.company_id || "")) fail(404, "Payroll period not found.");
    if (period.status !== "Published")
      fail(409, "Publish the finalized payroll before marking it paid.");
    const d = await body(req),
      reference = clean(d.reference, 120);
    run(
      "UPDATE payroll_periods SET status='Paid',paid_at=?,payment_reference=?,updated_at=? WHERE id=?",
      now(),
      reference,
      now(),
      period.id,
    );
    run(
      "INSERT INTO payroll_approvals VALUES(?,?,?,?,?,?,?)",
      id(),
      period.id,
      "Payment",
      user.id,
      "Paid",
      reference,
      now(),
    );
    run(
      "UPDATE payroll_items SET updated_at=? WHERE period_id=?",
      now(),
      period.id,
    );
    for (const item of all(
      "SELECT user_id FROM payroll_items WHERE period_id=?",
      period.id,
    ))
      notify(
        item.user_id,
        "Payroll marked paid",
        `Your ${period.period} payroll is marked paid.`,
        "payroll",
        period.id,
      );
    audit(
      user.id,
      "Marked payroll period paid",
      "payroll_period",
      period.id,
      reference,
    );
    return json(res, 200, {
      period: serializePeriod(
        q("SELECT * FROM payroll_periods WHERE id=?", period.id),
      ),
    });
  }
  const adjustment = p.match(
    /^\/api\/hrm\/payroll\/items\/([\w-]+)\/adjustments$/,
  );
  if (adjustment && method === "POST") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    const item = q(
        "SELECT i.*,p.status,p.company_id FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id WHERE i.id=?",
      adjustment[1],
    );
    if (!item) fail(404, "Payroll item not found.");
    if (user.role !== SUPER_ADMIN && String(item.company_id || "") !== String(user.company_id || "")) fail(404, "Payroll item not found.");
    if (!["Finalized", "Published", "Paid"].includes(item.status))
      fail(409, "Use draft recalculation before payroll is finalized.");
    const d = await body(req),
      amount = Number(d.amount);
    if (!Number.isFinite(amount) || amount === 0)
      fail(400, "Adjustment must be a non-zero signed amount in INR.");
    const paise = Math.round(amount * 100),
      reason = clean(d.reason, 500);
    if (!reason) fail(400, "A reason is required for payroll corrections.");
    const adj = id();
    run(
      "INSERT INTO payroll_adjustments VALUES(?,?,?,?,?,?)",
      adj,
      item.id,
      paise,
      reason,
      user.id,
      now(),
    );
    audit(
      user.id,
      "Recorded payroll adjustment",
      "payroll_adjustment",
      adj,
      `${item.user_id} · ${paise} paise · ${reason}`,
    );
    notify(
      item.user_id,
      "Payroll correction recorded",
      `${reason} (${amount < 0 ? "-" : ""}${Math.abs(amount).toFixed(2)} INR).`,
      "payroll",
      item.id,
    );
    return json(res, 201, { id: adj });
  }
  // Payroll deduction management. Rules are soft-deactivated so historic payroll remains explainable.
  if (p === "/api/hrm/payroll/deduction-rules" && method === "GET") {
    if (!requireRole(user, [ADMIN], json, res)) return true;
    const companyId = user.company_id || "";
    return json(res, 200, { rules: all(
      "SELECT r.*,u.name AS employee_name FROM payroll_deduction_rules r LEFT JOIN users u ON u.id=r.employee_id WHERE r.company_id=? ORDER BY r.active DESC,r.name,r.effective_from DESC",
      companyId,
    ) });
  }
  if (p === "/api/hrm/payroll/deduction-rules" && method === "POST") {
    if (!requireRole(user, [ADMIN], json, res)) return true;
    const d = await body(req),
      name = clean(d.name, 100),
      method = d.calculation_method === "percentage" ? "percentage" : "fixed",
      frequency = d.frequency === "one_time" ? "one_time" : "monthly",
      targetPeriod = frequency === "one_time" ? cleanPeriod(d.period) : "",
      employeeId = clean(d.employee_id, 80),
      effectiveFrom = clean(d.effective_from, 10),
      effectiveTo = d.effective_to ? clean(d.effective_to, 10) : null,
      basis = ["gross", "basic"].includes(d.percentage_basis) ? d.percentage_basis : "gross";
    if (!name) fail(400, "Deduction name is required.");
    if (!parseDate(effectiveFrom) || (effectiveTo && !parseDate(effectiveTo)) || (effectiveTo && effectiveTo < effectiveFrom)) fail(400, "Enter a valid effective date range.");
    if (employeeId) {
      const target = q("SELECT id,company_id,role FROM users WHERE id=?", employeeId);
      if (!target || target.role !== EMPLOYEE || (target.company_id || "") !== (user.company_id || "")) fail(400, "Choose an employee in your company.");
    }
    if (frequency === "one_time" && (!employeeId || method !== "fixed")) fail(400, "One-time deductions must be fixed-amount and assigned to one employee.");
    let monthlyPaise = 0, percentage = 0;
    if (method === "fixed") {
      monthlyPaise = amountPaise(d.amount, "Monthly deduction");
      if (!monthlyPaise) fail(400, "Monthly deduction must be greater than zero.");
    } else {
      percentage = Number(d.percentage);
      if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) fail(400, "Percentage must be greater than 0 and at most 100.");
    }
    const ruleId = id();
    run("INSERT INTO payroll_deduction_rules(id,company_id,employee_id,name,calculation_method,amount_paise,percentage,percentage_basis,frequency,period,effective_from,effective_to,active,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,1,?,?,?)",
      ruleId, user.company_id || "", employeeId || null, name, method, monthlyPaise, percentage, basis, frequency, targetPeriod, effectiveFrom, effectiveTo, user.id, now(), now());
    audit(user.id, "Created payroll deduction rule", "payroll_deduction_rule", ruleId, `${name} · ${employeeId || "company-wide"}`);
    return json(res, 201, { rule: q("SELECT * FROM payroll_deduction_rules WHERE id=?", ruleId) });
  }
  const deductionRuleMatch = p.match(/^\/api\/hrm\/payroll\/deduction-rules\/([\w-]+)$/);
  if (deductionRuleMatch && method === "PATCH") {
    if (!requireRole(user, [ADMIN], json, res)) return true;
    const rule = q("SELECT * FROM payroll_deduction_rules WHERE id=? AND company_id=?", deductionRuleMatch[1], user.company_id || "");
    if (!rule) fail(404, "Deduction rule not found.");
    const d = await body(req), active = d.active ? 1 : 0;
    run("UPDATE payroll_deduction_rules SET active=?,updated_at=? WHERE id=?", active, now(), rule.id);
    audit(user.id, active ? "Activated payroll deduction rule" : "Deactivated payroll deduction rule", "payroll_deduction_rule", rule.id, rule.name);
    return json(res, 200, { rule: q("SELECT * FROM payroll_deduction_rules WHERE id=?", rule.id) });
  }

  // Payroll Policy Management APIs
  if (p === "/api/hrm/payroll/policies" && method === "GET") {
    if (!requireRole(user, [ADMIN, HR, PAYROLL], json, res)) return true;
    const policies = all(
      "SELECT * FROM payroll_policies WHERE COALESCE(company_id,'') IN (?, '') ORDER BY (status='Active') DESC, effective_from DESC, created_at DESC",
      user.company_id || "",
    );
    return json(res, 200, {
      policies: policies.map((pol) => ({
        ...pol,
        weekly_off_days: parse(pol.weekly_off_days_json, [0, 6]),
        custom_rules: parse(pol.custom_rules_json, []),
      })),
    });
  }

  const policyIdMatch = p.match(/^\/api\/hrm\/payroll\/policies\/([\w-]+)$/);
  if (policyIdMatch && method === "GET") {
    if (!requireRole(user, [ADMIN, HR, PAYROLL], json, res)) return true;
    const pol = q("SELECT * FROM payroll_policies WHERE id=?", policyIdMatch[1]);
    if (!pol) fail(404, "Payroll policy not found.");
    if (!requireCompanyUser(user, pol.created_by || user.id, json, res) && String(pol.company_id || "") !== "") return true;
    const history = all(
      "SELECT h.*, u.name AS actor_name FROM payroll_policy_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.policy_id=? ORDER BY h.version DESC, h.created_at DESC",
      pol.id,
    );
    return json(res, 200, {
      policy: {
        ...pol,
        weekly_off_days: parse(pol.weekly_off_days_json, [0, 6]),
        custom_rules: parse(pol.custom_rules_json, []),
      },
      history: history.map((h) => ({
        ...h,
        snapshot: parse(h.snapshot_json, {}),
      })),
    });
  }

  if (p === "/api/hrm/payroll/policies" && method === "POST") {
    if (!requireRole(user, [ADMIN, PAYROLL], json, res)) return true;
    const d = await body(req);
    const name = clean(d.name, 120);
    if (!name) fail(400, "Policy name is required.");
    const code = clean(d.code || `POL-${Date.now().toString(36).toUpperCase()}`, 30);
    const status = ["Active", "Draft", "Inactive"].includes(d.status) ? d.status : "Draft";
    const effective_from = clean(d.effective_from || today().slice(0, 10), 10);
    const effective_to = d.effective_to ? clean(d.effective_to, 10) : null;
    const salary_calculation_method = [
      "calendar_days",
      "fixed_30",
      "working_days",
      "custom_divisor",
    ].includes(d.salary_calculation_method)
      ? d.salary_calculation_method
      : "calendar_days";
    const fixed_divisor = Math.max(1, Math.min(365, Number(d.fixed_divisor) || 30));
    const custom_divisor = Math.max(1, Math.min(365, Number(d.custom_divisor) || 30));
    const weekly_off_days = Array.isArray(d.weekly_off_days)
      ? d.weekly_off_days.map(Number)
      : [0, 6];
    const weekly_offs_paid = d.weekly_offs_paid ? 1 : 0;
    const sandwich_weekly_offs = d.sandwich_weekly_offs ? 1 : 0;
    const weekly_offs_in_divisor = d.weekly_offs_in_divisor ? 1 : 0;
    const holidays_paid = d.holidays_paid ? 1 : 0;
    const sandwich_holidays = d.sandwich_holidays ? 1 : 0;
    const proration_method = ["calendar_days", "working_days"].includes(d.proration_method)
      ? d.proration_method
      : "calendar_days";
    const leave_deduction_divisor_method = [
      "calendar_days",
      "working_days",
      "fixed_30",
    ].includes(d.leave_deduction_divisor_method)
      ? d.leave_deduction_divisor_method
      : "calendar_days";
    const unpaid_leave_enabled = d.unpaid_leave_enabled !== false ? 1 : 0;
    const half_day_factor = Number.isFinite(Number(d.half_day_factor))
      ? Math.max(0, Math.min(1, Number(d.half_day_factor)))
      : 0.5;
    const late_deduction_enabled = d.late_deduction_enabled ? 1 : 0;
    const late_grace_minutes = Number.isFinite(Number(d.late_grace_minutes)) ? Math.max(0, Math.min(240, Number(d.late_grace_minutes))) : 15;
    const late_penalty_paise = Math.max(0, Number(d.late_penalty_paise) || 0);
    const shift_start_time = /^([01]\d|2[0-3]):[0-5]\d$/.test(d.shift_start_time || "") ? d.shift_start_time : "10:10";
    const attendance_deduction_enabled = d.attendance_deduction_enabled ? 1 : 0;
    const custom_rules_json = JSON.stringify(Array.isArray(d.custom_rules) ? d.custom_rules : []);
    const pid = id();

    db.exec("BEGIN IMMEDIATE");
    try {
      if (status === "Active") {
        run(
          "UPDATE payroll_policies SET status='Inactive', updated_at=? WHERE status='Active' AND COALESCE(company_id,'')=?",
          now(),
          user.company_id || "",
        );
      }
      run(
        `INSERT INTO payroll_policies(
          id, company_id, name, code, status, version, effective_from, effective_to,
          salary_calculation_method, fixed_divisor, custom_divisor, weekly_off_days_json,
          weekly_offs_paid, sandwich_weekly_offs, weekly_offs_in_divisor, holidays_paid,
          sandwich_holidays, proration_method, leave_deduction_divisor_method, unpaid_leave_enabled,
          half_day_factor, late_deduction_enabled, late_grace_minutes, late_penalty_paise, shift_start_time,
          attendance_deduction_enabled, custom_rules_json, created_by, created_at, updated_at
        ) VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        pid,
        user.company_id || "",
        name,
        code,
        status,
        effective_from,
        effective_to,
        salary_calculation_method,
        fixed_divisor,
        custom_divisor,
        JSON.stringify(weekly_off_days),
        weekly_offs_paid,
        sandwich_weekly_offs,
        weekly_offs_in_divisor,
        holidays_paid,
        sandwich_holidays,
        proration_method,
        leave_deduction_divisor_method,
        unpaid_leave_enabled,
        half_day_factor,
        late_deduction_enabled,
        late_grace_minutes,
        late_penalty_paise,
        shift_start_time,
        attendance_deduction_enabled,
        custom_rules_json,
        user.id,
        now(),
        now(),
      );
      const inserted = q("SELECT * FROM payroll_policies WHERE id=?", pid);
      run(
        "INSERT INTO payroll_policy_history(id, policy_id, version, snapshot_json, action, actor_id, created_at) VALUES(?,?,?,?,?,?,?)",
        id(),
        pid,
        1,
        JSON.stringify(inserted),
        "create",
        user.id,
        now(),
      );
      audit(user.id, `Created payroll policy ${name} (v1, ${status})`, "payroll_policy", pid);
      db.exec("COMMIT");
      return json(res, 201, { policy: inserted });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  if (policyIdMatch && method === "PUT") {
    if (!requireRole(user, [ADMIN, PAYROLL], json, res)) return true;
    const existing = q("SELECT * FROM payroll_policies WHERE id=?", policyIdMatch[1]);
    if (!existing) fail(404, "Payroll policy not found.");
    if (String(existing.company_id || "") !== String(user.company_id || "")) fail(404, "Payroll policy not found.");
    const d = await body(req);
    const name = clean(d.name || existing.name, 120);
    const code = clean(d.code || existing.code, 30);
    const status = ["Active", "Draft", "Inactive"].includes(d.status) ? d.status : existing.status;
    const effective_from = clean(d.effective_from || existing.effective_from, 10);
    const effective_to = d.effective_to !== undefined ? (d.effective_to ? clean(d.effective_to, 10) : null) : existing.effective_to;
    const salary_calculation_method = [
      "calendar_days",
      "fixed_30",
      "working_days",
      "custom_divisor",
    ].includes(d.salary_calculation_method)
      ? d.salary_calculation_method
      : existing.salary_calculation_method;
    const fixed_divisor = Math.max(1, Math.min(365, Number(d.fixed_divisor) || existing.fixed_divisor));
    const custom_divisor = Math.max(1, Math.min(365, Number(d.custom_divisor) || existing.custom_divisor));
    const weekly_off_days = Array.isArray(d.weekly_off_days)
      ? d.weekly_off_days.map(Number)
      : parse(existing.weekly_off_days_json, [0, 6]);
    const weekly_offs_paid = d.weekly_offs_paid !== undefined ? (d.weekly_offs_paid ? 1 : 0) : existing.weekly_offs_paid;
    const sandwich_weekly_offs = d.sandwich_weekly_offs !== undefined ? (d.sandwich_weekly_offs ? 1 : 0) : existing.sandwich_weekly_offs;
    const weekly_offs_in_divisor = d.weekly_offs_in_divisor !== undefined ? (d.weekly_offs_in_divisor ? 1 : 0) : existing.weekly_offs_in_divisor;
    const holidays_paid = d.holidays_paid !== undefined ? (d.holidays_paid ? 1 : 0) : existing.holidays_paid;
    const sandwich_holidays = d.sandwich_holidays !== undefined ? (d.sandwich_holidays ? 1 : 0) : existing.sandwich_holidays;
    const proration_method = ["calendar_days", "working_days"].includes(d.proration_method)
      ? d.proration_method
      : existing.proration_method;
    const leave_deduction_divisor_method = [
      "calendar_days",
      "working_days",
      "fixed_30",
    ].includes(d.leave_deduction_divisor_method)
      ? d.leave_deduction_divisor_method
      : existing.leave_deduction_divisor_method;
    const unpaid_leave_enabled = d.unpaid_leave_enabled !== undefined ? (d.unpaid_leave_enabled ? 1 : 0) : existing.unpaid_leave_enabled;
    const half_day_factor = Number.isFinite(Number(d.half_day_factor))
      ? Math.max(0, Math.min(1, Number(d.half_day_factor)))
      : existing.half_day_factor;
    const late_deduction_enabled = d.late_deduction_enabled !== undefined ? (d.late_deduction_enabled ? 1 : 0) : existing.late_deduction_enabled;
    const late_grace_minutes = d.late_grace_minutes !== undefined && Number.isFinite(Number(d.late_grace_minutes))
      ? Math.max(0, Math.min(240, Number(d.late_grace_minutes)))
      : existing.late_grace_minutes;
    const late_penalty_paise = d.late_penalty_paise !== undefined && Number.isFinite(Number(d.late_penalty_paise))
      ? Math.max(0, Math.round(Number(d.late_penalty_paise)))
      : existing.late_penalty_paise;
    const shift_start_time = d.shift_start_time && /^([01]\d|2[0-3]):[0-5]\d$/.test(d.shift_start_time) ? d.shift_start_time : (existing.shift_start_time || "10:10");
    const attendance_deduction_enabled = d.attendance_deduction_enabled !== undefined ? (d.attendance_deduction_enabled ? 1 : 0) : existing.attendance_deduction_enabled;
    const custom_rules_json = d.custom_rules ? JSON.stringify(d.custom_rules) : existing.custom_rules_json;
    const newVersion = (existing.version || 1) + 1;

    db.exec("BEGIN IMMEDIATE");
    try {
      if (status === "Active" && existing.status !== "Active") {
        run(
          "UPDATE payroll_policies SET status='Inactive', updated_at=? WHERE status='Active' AND COALESCE(company_id,'')=? AND id<>?",
          now(),
          user.company_id || "",
          existing.id,
        );
      }
      run(
        `UPDATE payroll_policies SET
          name=?, code=?, status=?, version=?, effective_from=?, effective_to=?,
          salary_calculation_method=?, fixed_divisor=?, custom_divisor=?, weekly_off_days_json=?,
          weekly_offs_paid=?, sandwich_weekly_offs=?, weekly_offs_in_divisor=?, holidays_paid=?,
          sandwich_holidays=?, proration_method=?, leave_deduction_divisor_method=?, unpaid_leave_enabled=?,
          half_day_factor=?, late_deduction_enabled=?, late_grace_minutes=?, late_penalty_paise=?, shift_start_time=?,
          attendance_deduction_enabled=?, custom_rules_json=?, updated_at=?
        WHERE id=?`,
        name,
        code,
        status,
        newVersion,
        effective_from,
        effective_to,
        salary_calculation_method,
        fixed_divisor,
        custom_divisor,
        JSON.stringify(weekly_off_days),
        weekly_offs_paid,
        sandwich_weekly_offs,
        weekly_offs_in_divisor,
        holidays_paid,
        sandwich_holidays,
        proration_method,
        leave_deduction_divisor_method,
        unpaid_leave_enabled,
        half_day_factor,
        late_deduction_enabled,
        late_grace_minutes,
        late_penalty_paise,
        shift_start_time,
        attendance_deduction_enabled,
        custom_rules_json,
        now(),
        existing.id,
      );
      const updated = q("SELECT * FROM payroll_policies WHERE id=?", existing.id);
      run(
        "INSERT INTO payroll_policy_history(id, policy_id, version, snapshot_json, action, actor_id, created_at) VALUES(?,?,?,?,?,?,?)",
        id(),
        existing.id,
        newVersion,
        JSON.stringify(updated),
        "update",
        user.id,
        now(),
      );
      audit(user.id, `Updated payroll policy ${name} (v${newVersion})`, "payroll_policy", existing.id);
      db.exec("COMMIT");
      return json(res, 200, { policy: updated });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  const publishPolicyMatch = p.match(/^\/api\/hrm\/payroll\/policies\/([\w-]+)\/publish$/);
  if (publishPolicyMatch && method === "POST") {
    if (!requireRole(user, [ADMIN], json, res)) return true;
    const policy = q("SELECT * FROM payroll_policies WHERE id=?", publishPolicyMatch[1]);
    if (!policy) fail(404, "Payroll policy not found.");
    if (String(policy.company_id || "") !== String(user.company_id || "")) fail(404, "Payroll policy not found.");
    db.exec("BEGIN IMMEDIATE");
    try {
      run(
        "UPDATE payroll_policies SET status='Inactive', updated_at=? WHERE status='Active' AND COALESCE(company_id,'')=? AND id<>?",
        now(),
        user.company_id || "",
        policy.id,
      );
      run(
        "UPDATE payroll_policies SET status='Active', updated_at=? WHERE id=?",
        now(),
        policy.id,
      );
      const updated = q("SELECT * FROM payroll_policies WHERE id=?", policy.id);
      run(
        "INSERT INTO payroll_policy_history(id, policy_id, version, snapshot_json, action, actor_id, created_at) VALUES(?,?,?,?,?,?,?)",
        id(),
        policy.id,
        policy.version,
        JSON.stringify(updated),
        "publish",
        user.id,
        now(),
      );
      audit(user.id, `Published payroll policy ${policy.name} as active`, "payroll_policy", policy.id);
      db.exec("COMMIT");
      return json(res, 200, { ok: true, policy: updated });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  const rollbackPolicyMatch = p.match(/^\/api\/hrm\/payroll\/policies\/([\w-]+)\/rollback$/);
  if (rollbackPolicyMatch && method === "POST") {
    if (!requireRole(user, [ADMIN], json, res)) return true;
    const policy = q("SELECT * FROM payroll_policies WHERE id=?", rollbackPolicyMatch[1]);
    if (!policy) fail(404, "Payroll policy not found.");
    if (String(policy.company_id || "") !== String(user.company_id || "")) fail(404, "Payroll policy not found.");
    const d = await body(req);
    const targetVersion = Number(d.version);
    const hist = q(
      "SELECT * FROM payroll_policy_history WHERE policy_id=? AND version=? ORDER BY created_at DESC LIMIT 1",
      policy.id,
      targetVersion,
    );
    if (!hist) fail(404, `Policy version ${targetVersion} not found in history.`);
    const snap = parse(hist.snapshot_json, null);
    if (!snap) fail(400, "Corrupt history snapshot.");
    const newVersion = (policy.version || 1) + 1;
    db.exec("BEGIN IMMEDIATE");
    try {
      run(
        `UPDATE payroll_policies SET
          name=?, code=?, status=?, version=?, effective_from=?, effective_to=?,
          salary_calculation_method=?, fixed_divisor=?, custom_divisor=?, weekly_off_days_json=?,
          weekly_offs_paid=?, sandwich_weekly_offs=?, weekly_offs_in_divisor=?, holidays_paid=?,
          sandwich_holidays=?, proration_method=?, leave_deduction_divisor_method=?, unpaid_leave_enabled=?,
          half_day_factor=?, late_deduction_enabled=?, late_grace_minutes=?, late_penalty_paise=?, shift_start_time=?,
          attendance_deduction_enabled=?, custom_rules_json=?, updated_at=?
        WHERE id=?`,
        snap.name,
        snap.code,
        snap.status,
        newVersion,
        snap.effective_from,
        snap.effective_to,
        snap.salary_calculation_method,
        snap.fixed_divisor,
        snap.custom_divisor,
        snap.weekly_off_days_json,
        snap.weekly_offs_paid,
        snap.sandwich_weekly_offs,
        snap.weekly_offs_in_divisor,
        snap.holidays_paid,
        snap.sandwich_holidays,
        snap.proration_method,
        snap.leave_deduction_divisor_method,
        snap.unpaid_leave_enabled,
        snap.half_day_factor,
        snap.late_deduction_enabled,
        snap.late_grace_minutes,
        snap.late_penalty_paise,
        snap.shift_start_time || "10:10",
        snap.attendance_deduction_enabled,
        snap.custom_rules_json,
        now(),
        policy.id,
      );
      const restored = q("SELECT * FROM payroll_policies WHERE id=?", policy.id);
      run(
        "INSERT INTO payroll_policy_history(id, policy_id, version, snapshot_json, action, actor_id, created_at) VALUES(?,?,?,?,?,?,?)",
        id(),
        policy.id,
        newVersion,
        JSON.stringify(restored),
        `rollback_to_v${targetVersion}`,
        user.id,
        now(),
      );
      audit(user.id, `Rolled back policy ${policy.name} to version ${targetVersion}`, "payroll_policy", policy.id);
      db.exec("COMMIT");
      return json(res, 200, { ok: true, policy: restored });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  if (p === "/api/hrm/payroll/policies/preview" && method === "POST") {
    if (!requireRole(user, [ADMIN, HR, PAYROLL], json, res)) return true;
    const d = await body(req);
    const monthlySalary = Number(d.monthly_salary) || 15000;
    const monthlyGrossPaise = Math.round(monthlySalary * 100);
    const period = cleanPeriod(d.period || today().slice(0, 7));
    const joinDate = d.start_date ? clean(d.start_date, 10) : "";
    const exitDate = d.exit_date ? clean(d.exit_date, 10) : "";
    const approvedHalfDay = Boolean(d.has_approved_half_day);
    const isHalfDayUnpaid = Boolean(d.is_half_day_unpaid);
    const unpaidDaysInput = Number(d.unpaid_days || 0);

    const testPolicy = {
      id: d.policy?.id || "preview",
      name: d.policy?.name || "Preview Policy",
      version: 1,
      salary_calculation_method: d.policy?.salary_calculation_method || "calendar_days",
      fixed_divisor: Number(d.policy?.fixed_divisor) || 30,
      custom_divisor: Number(d.policy?.custom_divisor) || 30,
      weekly_off_days_json: JSON.stringify(d.policy?.weekly_off_days || [0, 6]),
      weekly_offs_paid: d.policy?.weekly_offs_paid !== false ? 1 : 0,
      sandwich_weekly_offs: d.policy?.sandwich_weekly_offs ? 1 : 0,
      weekly_offs_in_divisor: d.policy?.weekly_offs_in_divisor !== false ? 1 : 0,
      holidays_paid: d.policy?.holidays_paid !== false ? 1 : 0,
      sandwich_holidays: d.policy?.sandwich_holidays ? 1 : 0,
      proration_method: d.policy?.proration_method || "calendar_days",
      leave_deduction_divisor_method: d.policy?.leave_deduction_divisor_method || "calendar_days",
      unpaid_leave_enabled: d.policy?.unpaid_leave_enabled !== false ? 1 : 0,
      half_day_factor: Number.isFinite(Number(d.policy?.half_day_factor)) ? Number(d.policy.half_day_factor) : 0.5,
      late_deduction_enabled: d.policy?.late_deduction_enabled ? 1 : 0,
      shift_start_time: d.policy?.shift_start_time || "10:10",
      late_grace_minutes: Number.isFinite(Number(d.policy?.late_grace_minutes)) ? Math.max(0, Math.min(240, Number(d.policy.late_grace_minutes))) : 15,
      late_penalty_paise: Math.max(0, Number(d.policy?.late_penalty_paise) || 0),
      attendance_deduction_enabled: d.policy?.attendance_deduction_enabled ? 1 : 0,
      custom_rules_json: "[]",
    };

    const dummyUser = { id: "preview-user", name: d.employee_name || "Preview Employee" };
    const dummyEmployee = {
      user_id: dummyUser.id,
      start_date: joinDate,
      exit_date: exitDate,
      annual_ctc_paise: monthlyGrossPaise * 12,
    };
    const basicPaise = Math.round(monthlyGrossPaise * 0.5);
    const allowancesPaise = monthlyGrossPaise - basicPaise;
    const dummyStructure = {
      id: "preview-struct",
      user_id: dummyUser.id,
      effective_from: `${period}-01`,
      basic_paise: basicPaise,
      allowances_json: JSON.stringify([{ name: "Special Allowance", amount_paise: allowancesPaise }]),
      workday_method: testPolicy.salary_calculation_method === "calendar_days" ? "calendar_days" : "working_days",
      weekly_offs_json: testPolicy.weekly_off_days_json,
    };

    const categories = [
      { name: "Paid", category: "Paid", entitlement_days: 12 },
      { name: "Unpaid", category: "Unpaid", entitlement_days: 0 },
    ];

    const result = calculateEmployee(
      dummyUser,
      dummyEmployee,
      dummyStructure,
      period,
      categories,
      testPolicy,
    );

    // Apply simulation overrides if specific test knobs were provided
    if (approvedHalfDay) {
      if (isHalfDayUnpaid) {
        const leaveDivisor = result.calculation_json ? parse(result.calculation_json, {}).leave_divisor_days : 31;
        const halfDayDeduction = testPolicy.unpaid_leave_enabled
          ? Math.round((monthlyGrossPaise * testPolicy.half_day_factor) / (leaveDivisor || 30))
          : 0;
        result.unpaid_leave_days = testPolicy.half_day_factor;
        result.leave_deduction_paise = halfDayDeduction;
        result.total_deductions_paise = halfDayDeduction;
        result.net_paise = result.gross_paise - halfDayDeduction;
      } else {
        result.paid_leave_days = testPolicy.half_day_factor;
      }
    } else if (unpaidDaysInput > 0) {
      const leaveDivisor = result.calculation_json ? parse(result.calculation_json, {}).leave_divisor_days : 31;
      const leaveDeduction = testPolicy.unpaid_leave_enabled
        ? Math.round((monthlyGrossPaise * unpaidDaysInput) / (leaveDivisor || 30))
        : 0;
      result.unpaid_leave_days = unpaidDaysInput;
      result.leave_deduction_paise = leaveDeduction;
      result.total_deductions_paise = leaveDeduction;
      result.net_paise = result.gross_paise - leaveDeduction;
    }

    const calculation = parse(result.calculation_json, {});
    result.payable_days = Math.max(0, Number(calculation.eligible_days || 0) - result.unpaid_leave_days);
    calculation.paid_leave_days = result.paid_leave_days;
    calculation.unpaid_leave_days = result.unpaid_leave_days;
    calculation.payable_days = result.payable_days;
    calculation.leave_deduction_paise = result.leave_deduction_paise;
    calculation.total_deductions_paise = result.total_deductions_paise;
    calculation.net_paise = result.net_paise;
    result.calculation_json = JSON.stringify(calculation);

    return json(res, 200, {
      preview: {
        ...result,
        monthly_salary_paise: monthlyGrossPaise,
        calculation,
      },
    });
  }

  if (p === "/api/hrm/reports" && method === "GET") {
    if (!requireRole(user, [ADMIN, HR, PAYROLL, MANAGER], json, res))
      return true;
    const period = cleanPeriod(
      url.searchParams.get("period") || new Date().toISOString().slice(0, 7),
    );
    const pay = isRole(user, [MANAGER])
      ? []
      : all(
          "SELECT u.name,e.department,i.* FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id JOIN users u ON u.id=i.user_id JOIN employees e ON e.user_id=u.id WHERE p.period=? AND p.status IN ('Finalized','Published','Paid') ORDER BY e.department,u.name",
          period,
        );
    const tasks = isRole(user, [MANAGER])
      ? all(
          "SELECT t.status,t.priority,t.due_date,e.department FROM tasks t JOIN employees e ON e.user_id=t.user_id WHERE e.department=(SELECT department FROM employees WHERE user_id=?)",
          user.id,
        )
      : all(
          "SELECT t.status,t.priority,t.due_date,e.department FROM tasks t JOIN employees e ON e.user_id=t.user_id",
        );
    const leave = all(
      "SELECT r.leave_type,r.status,r.days,e.department FROM requests r JOIN employees e ON e.user_id=r.user_id WHERE r.kind='Leave' AND substr(COALESCE(r.start_date,r.created_at),1,7)=?",
      period,
    );
    return json(res, 200, {
      period,
      payroll: {
        employees: pay.length,
        gross_paise: pay.reduce((n, x) => n + x.gross_paise, 0),
        deductions_paise: pay.reduce((n, x) => n + x.total_deductions_paise, 0),
        net_paise: pay.reduce((n, x) => n + x.net_paise, 0),
        unpaid_leave_days: pay.reduce((n, x) => n + x.unpaid_leave_days, 0),
        by_department: Object.values(
          pay.reduce((a, x) => {
            const k = x.department || "Unassigned";
            a[k] ??= {
              department: k,
              employees: 0,
              gross_paise: 0,
              net_paise: 0,
            };
            a[k].employees++;
            a[k].gross_paise += x.gross_paise;
            a[k].net_paise += x.net_paise;
            return a;
          }, {}),
        ),
        rows: pay,
      },
      tasks: {
        total: tasks.length,
        completed: tasks.filter((x) => x.status === "Completed").length,
        overdue: tasks.filter(
          (x) =>
            x.due_date &&
            x.due_date < new Date().toISOString().slice(0, 10) &&
            !["Completed"].includes(x.status),
        ).length,
        by_status: tasks.reduce(
          (a, x) => ((a[x.status] = (a[x.status] || 0) + 1), a),
          {},
        ),
      },
      leave: {
        total: leave.length,
        approved: leave.filter((x) => x.status === "Approved").length,
        pending: leave.filter((x) => x.status === "Pending").length,
        unpaid_days: leave
          .filter((x) => x.status === "Approved" && x.leave_type)
          .reduce((n, x) => {
            const c = q(
              "SELECT category FROM leave_categories WHERE name=?",
              x.leave_type,
            );
            return n + (c?.category === "Unpaid" ? Number(x.days || 0) : 0);
          }, 0),
      },
    });
  }
  if (p === "/api/hrm/reports/payroll.csv" && method === "GET") {
    if (!requireRole(user, [ADMIN, HR, PAYROLL], json, res)) return true;
    const period = cleanPeriod(
      url.searchParams.get("period") || new Date().toISOString().slice(0, 7),
    );
    const rows = all(
      `SELECT u.name,u.email,e.employee_code,e.department,i.*,p.status AS payroll_status FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id JOIN users u ON u.id=i.user_id JOIN employees e ON e.user_id=u.id WHERE p.period=? AND p.status IN ('Finalized','Published','Paid') AND ${companyWhere(user,"u").sql} ORDER BY e.department,u.name`,
      period, ...companyWhere(user,"u").args,
    );
    const header = [
      "Employee ID",
      "Employee",
      "Email",
      "Department",
      "Period",
      "Calendar Days",
      "Scheduled Days",
      "Present Days",
      "Paid Leave Days",
      "Unpaid Leave Days",
      "Gross INR",
      "Leave Deduction INR",
      "Other Deductions INR",
      "Net INR",
      "Status",
    ];
    const lines = [
      header,
      ...rows.map((x) => [
        x.employee_code,
        x.name,
        x.email,
        x.department,
        period,
        x.calendar_days,
        x.scheduled_days,
        x.present_days,
        x.paid_leave_days,
        x.unpaid_leave_days,
        (x.gross_paise / 100).toFixed(2),
        (x.leave_deduction_paise / 100).toFixed(2),
        ((x.total_deductions_paise - x.leave_deduction_paise) / 100).toFixed(2),
        (x.net_paise / 100).toFixed(2),
        x.payroll_status,
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="macrow-payroll-${period}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end("\uFEFF" + lines);
    return true;
  }
  if (p === "/api/hrm/payroll/item/payslip" && method === "GET") {
    const itemId = clean(url.searchParams.get("id"), 80),
      row = q(
        "SELECT i.*,p.period,p.company_id,p.status AS period_status,p.paid_at,p.payment_reference,u.name,u.email,e.employee_code,e.title,e.department,e.start_date FROM payroll_items i JOIN payroll_periods p ON p.id=i.period_id JOIN users u ON u.id=i.user_id JOIN employees e ON e.user_id=u.id WHERE i.id=?",
        itemId,
      );
    if (!row) fail(404, "Payslip not found.");
    if (!sameCompany(user, row.user_id)) fail(404, "Payslip not found.");
    if (!periodItemForUser(row, user)) {
      json(res, 403, { error: "You can only view your own payslip." });
      return true;
    }
    if (
      isRole(user, [EMPLOYEE]) &&
      !["Published", "Paid"].includes(row.period_status)
    )
      fail(404, "Payslip is not published yet.");
    return json(res, 200, {
      payslip: {
        ...serializeItem(row),
        period: row.period,
        period_status: row.period_status,
        paid_at: row.paid_at,
        payment_reference: row.payment_reference,
        employee: {
          name: row.name,
          email: row.email,
          employee_code: row.employee_code,
          title: row.title,
          department: row.department,
          start_date: row.start_date,
        },
        company: "Macrow Digital",
      },
    });
  }
  if (p === "/api/hrm/payroll/adjustment" && method === "GET") {
    if (!requireRole(user, PAYROLL_ROLES, json, res)) return true;
    return json(res, 200, {
      adjustments: all(
        "SELECT a.*,u.name FROM payroll_adjustments a JOIN users u ON u.id=a.created_by JOIN payroll_items i ON i.id=a.payroll_item_id JOIN payroll_periods p ON p.id=i.period_id WHERE p.company_id=? ORDER BY a.created_at DESC LIMIT 300",
        user.company_id || "",
      ),
    });
  }

  // Super Admin Management APIs
  if (p === "/api/hrm/super-admin/stats" && method === "GET") {
    if (!requireRole(user, [SUPER_ADMIN], json, res)) return true;
    const totalCompanies = Number(q("SELECT COUNT(*) n FROM companies")?.n || 0);
    const activeCompanies = Number(q("SELECT COUNT(*) n FROM companies WHERE status='Active'")?.n || 0);
    const totalCompanyAdmins = Number(q("SELECT COUNT(*) n FROM users WHERE role='admin'")?.n || 0);
    const totalEmployees = Number(q("SELECT COUNT(*) n FROM users WHERE role<>'super_admin'")?.n || 0);
    return json(res, 200, {
      stats: {
        totalCompanies,
        activeCompanies,
        totalCompanyAdmins,
        totalEmployees,
      },
    });
  }

  if (p === "/api/hrm/companies" && method === "GET") {
    if (!requireRole(user, [SUPER_ADMIN], json, res)) return true;
    const rows = all(`
      SELECT c.*,
        u.id AS admin_id,
        u.name AS admin_name,
        u.email AS admin_email,
        u.active AS admin_active,
        (SELECT COUNT(*) FROM users u2 WHERE u2.company_id = c.id AND u2.role <> 'super_admin') AS total_users
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id AND u.role = 'admin'
      ORDER BY c.created_at DESC
    `);
    return json(res, 200, { companies: rows });
  }

  if (p === "/api/hrm/companies" && method === "POST") {
    if (!requireRole(user, [SUPER_ADMIN], json, res)) return true;
    const d = await body(req);
    const companyName = clean(d.name, 120);
    const domain = clean(d.domain, 120);
    const plan = ["Starter", "Standard", "Enterprise"].includes(d.plan) ? d.plan : "Standard";
    const maxEmployees = Math.max(1, Number(d.max_employees) || 100);
    const adminName = clean(d.admin_name, 120);
    const adminEmail = clean(d.admin_email, 254).toLowerCase();
    const adminPassword = String(d.admin_password || "").trim();

    if (!companyName) fail(400, "Company name is required.");
    if (!adminName) fail(400, "Admin name is required.");
    if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail))
      fail(400, "Valid admin email is required.");
    if (!adminPassword || adminPassword.length < 12)
      fail(400, "Admin password must be at least 12 characters.");

    const existingUser = q("SELECT id FROM users WHERE lower(email)=?", adminEmail);
    if (existingUser) fail(409, "A user with this email address already exists.");

    const cid = id(), uid = id(), at = now();
    const passwordHash = hashPassword(adminPassword);

    db.exec("BEGIN IMMEDIATE");
    try {
      run(
        "INSERT INTO companies(id, name, domain, plan, max_employees, status, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        cid,
        companyName,
        domain,
        plan,
        maxEmployees,
        "Active",
        user.id,
        at,
        at,
      );
      run(
        "INSERT INTO users(id, company_id, email, name, role, password_hash, active, created_at) VALUES(?,?,?,?,?,?,1,?)",
        uid,
        cid,
        adminEmail,
        adminName,
        ADMIN,
        passwordHash,
        at,
      );
      run(
        "INSERT INTO employees(user_id, title, department, location, start_date) VALUES(?,?,?,?,?)",
        uid,
        "Company Administrator",
        "Executive",
        "Onsite",
        at.slice(0, 10),
      );
      audit(user.id, "Created company and admin", "company", cid, `${companyName} (${adminEmail})`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    return json(res, 201, {
      id: cid,
      company: {
        id: cid,
        name: companyName,
        domain,
        plan,
        max_employees: maxEmployees,
        status: "Active",
        admin: {
          id: uid,
          name: adminName,
          email: adminEmail,
        },
      },
    });
  }

  const companyMatch = p.match(/^\/api\/hrm\/companies\/([\w-]+)$/);
  if (companyMatch && method === "PATCH") {
    if (!requireRole(user, [SUPER_ADMIN], json, res)) return true;
    const cid = companyMatch[1];
    const company = q("SELECT * FROM companies WHERE id=?", cid);
    if (!company) fail(404, "Company not found.");
    const d = await body(req);
    const updates = [];
    const args = [];

    if (d.name !== undefined) {
      const name = clean(d.name, 120);
      if (!name) fail(400, "Company name cannot be empty.");
      updates.push("name=?");
      args.push(name);
    }
    if (d.domain !== undefined) {
      updates.push("domain=?");
      args.push(clean(d.domain, 120));
    }
    if (d.plan !== undefined && ["Starter", "Standard", "Enterprise"].includes(d.plan)) {
      updates.push("plan=?");
      args.push(d.plan);
    }
    if (d.max_employees !== undefined) {
      const maxEmp = Math.max(1, Number(d.max_employees) || 100);
      updates.push("max_employees=?");
      args.push(maxEmp);
    }
    if (d.status !== undefined && ["Active", "Suspended", "Archived"].includes(d.status)) {
      updates.push("status=?");
      args.push(d.status);
    }

    if (updates.length) {
      updates.push("updated_at=?");
      args.push(now());
      args.push(cid);
      run(`UPDATE companies SET ${updates.join(",")} WHERE id=?`, ...args);
      audit(user.id, "Updated company", "company", cid, JSON.stringify(d));
    }

    const updated = q("SELECT * FROM companies WHERE id=?", cid);
    return json(res, 200, { ok: true, company: updated });
  }

  return false;
}

// Kept separate so query-only credential routes don't consume a POST stream.
const bodyCache = new WeakMap();
async function awaitBodyCached(req) {
  if (!bodyCache.has(req)) bodyCache.set(req, body(req));
  return bodyCache.get(req);
}
async function body(req) {
  let chunks = [],
    size = 0,
    limit = req.url.startsWith("/api/documents")
      ? 14_500_000
      : req.url.includes("/profile")
        ? 2_500_000
        : 1_000_000;
  for await (const part of req) {
    size += part.length;
    if (size > limit) fail(413, "Request too large.");
    chunks.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    fail(400, "Invalid JSON body.");
  }
}

module.exports = { initUpgrades, routeUpgrade, calculateEmployee };
