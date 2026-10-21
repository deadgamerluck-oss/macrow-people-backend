"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { initUpgrades, calculateEmployee } = require("../upgrades");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','employee')),password_hash TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    CREATE TABLE employees(user_id TEXT PRIMARY KEY REFERENCES users(id),title TEXT NOT NULL DEFAULT '',department TEXT NOT NULL DEFAULT '',location TEXT NOT NULL DEFAULT 'Hybrid',phone TEXT NOT NULL DEFAULT '',emergency_contact TEXT NOT NULL DEFAULT '',start_date TEXT NOT NULL DEFAULT '',salary INTEGER NOT NULL DEFAULT 0,salary_currency TEXT NOT NULL DEFAULT 'INR');
    CREATE TABLE invites(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,title TEXT NOT NULL,department TEXT NOT NULL,location TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),used_at TEXT);
    CREATE TABLE requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,details TEXT NOT NULL,start_date TEXT,end_date TEXT,days REAL,status TEXT NOT NULL DEFAULT 'Pending',decision_note TEXT NOT NULL DEFAULT '',decided_by TEXT REFERENCES users(id),created_at TEXT NOT NULL,decided_at TEXT);
    CREATE TABLE leave_rules(id TEXT PRIMARY KEY,name TEXT NOT NULL,annual_days REAL NOT NULL DEFAULT 0,sick_days REAL NOT NULL DEFAULT 0,notes TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
    CREATE TABLE attendance(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),work_date TEXT NOT NULL,segments TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'out',UNIQUE(user_id,work_date));
    CREATE TABLE calendar_events(id TEXT PRIMARY KEY,title TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT,kind TEXT NOT NULL DEFAULT 'event',description TEXT NOT NULL DEFAULT '',approved INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,due_date TEXT,status TEXT NOT NULL DEFAULT 'To do',created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE activity_logs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
    CREATE TABLE audit_logs(id TEXT PRIMARY KEY,actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,entity TEXT NOT NULL,entity_id TEXT NOT NULL DEFAULT '',details TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "macrow-payroll-test-"));
  initUpgrades(db, folder);
  db.prepare(
    "INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)",
  ).run(
    "u1",
    "employee@example.test",
    "Test Employee",
    "employee",
    "2024-01-01T00:00:00.000Z",
  );
  db.prepare("INSERT INTO employees(user_id,start_date) VALUES(?,?)").run(
    "u1",
    "2024-01-01",
  );
  const user = { id: "u1", name: "Test Employee" };
  function structure(overrides = {}) {
    return {
      id: "s1",
      effective_from: "2024-01-01",
      workday_method: "calendar_days",
      weekly_offs_json: "[0]",
      paid_leave_entitlement: null,
      basic_paise: 3000000,
      allowances_json: "[]",
      earnings_json: "[]",
      deductions_json: "[]",
      ...overrides,
    };
  }
  function category(name, category, entitlement_days = 0, overrides = {}) {
    return {
      id: name,
      name,
      category,
      entitlement_days,
      exclude_non_working_days: 1,
      excess_to_unpaid: 1,
      ...overrides,
    };
  }
  function leave({
    id,
    start,
    end = start,
    days = 1,
    status = "Approved",
    type = "Unpaid",
  }) {
    db.prepare(
      "INSERT INTO requests(id,user_id,kind,details,start_date,end_date,days,status,created_at,leave_type) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      "u1",
      "Leave",
      "Test leave",
      start,
      end,
      days,
      status,
      `${start}T00:00:00.000Z`,
      type,
    );
  }
  function holiday(date) {
    db.prepare(
      "INSERT INTO calendar_events(id,title,start_date,end_date,kind,description,approved,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      `h-${date}`,
      "Test holiday",
      date,
      date,
      "holiday",
      "",
      1,
      "u1",
      `${date}T00:00:00.000Z`,
    );
  }
  function calculate(
    period = "2024-02",
    salary = structure(),
    categories = [category("Paid", "Paid", 12), category("Unpaid", "Unpaid")],
    employee = {
      id: "u1",
      name: "Test Employee",
      start_date: "2024-01-01",
      exit_date: "",
    },
  ) {
    return calculateEmployee(user, employee, salary, period, categories);
  }
  return {
    db,
    folder,
    calculate,
    leave,
    holiday,
    structure,
    category,
    close() {
      db.close();
      fs.rmSync(folder, { recursive: true, force: true });
    },
  };
}

test("leap-year payroll honors paid leave and deducts approved unpaid leave only", (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.leave({ id: "paid", start: "2024-02-06", type: "Paid" });
  f.leave({ id: "lwp", start: "2024-02-05" });
  const result = f.calculate();
  assert.equal(result.calendar_days, 29);
  assert.equal(result.paid_leave_days, 1);
  assert.equal(result.unpaid_leave_days, 1);
  assert.equal(result.leave_deduction_paise, Math.round(3000000 / 29));
  assert.equal(
    result.net_paise,
    result.gross_paise - result.total_deductions_paise,
  );
});

test("half-day unpaid leave is rounded in paise without binary-float drift", (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.leave({ id: "half", start: "2024-02-05", days: 0.5 });
  const result = f.calculate();
  assert.equal(result.unpaid_leave_days, 0.5);
  assert.equal(result.leave_deduction_paise, Math.round((3000000 * 0.5) / 29));
});

test("pending leave is flagged but does not reduce pay", (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.leave({ id: "pending", start: "2024-02-05", status: "Pending" });
  const result = f.calculate();
  assert.equal(result.unpaid_leave_days, 0);
  assert.equal(result.leave_deduction_paise, 0);
  assert.ok(result.validation.some((x) => x.code === "pending_leave"));
});

test("weekly offs and configured holidays are excluded from unpaid leave days", (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.holiday("2024-02-19");
  f.leave({ id: "weekend", start: "2024-02-18", end: "2024-02-19", days: 2 });
  const result = f.calculate();
  assert.equal(result.unpaid_leave_days, 0);
  assert.equal(result.leave_deduction_paise, 0);
});

test("salary is prorated to scheduled working days after an in-month joining date", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const result = f.calculate(
    "2024-02",
    f.structure({ workday_method: "working_days" }),
    [],
    {
      id: "u1",
      name: "Test Employee",
      start_date: "2024-02-15",
      exit_date: "",
    },
  );
  assert.ok(result.gross_paise > 0);
  assert.ok(result.gross_paise < 3000000);
  assert.equal(result.scheduled_days, 25);
});
