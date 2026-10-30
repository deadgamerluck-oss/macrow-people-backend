"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { initUpgrades, calculateEmployee, recalcPeriod, serializePeriod, routeUpgrade } = require("../upgrades");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('super_admin','admin','hr_manager','payroll_manager','manager','employee')),password_hash TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    CREATE TABLE employees(user_id TEXT PRIMARY KEY REFERENCES users(id),title TEXT NOT NULL DEFAULT '',department TEXT NOT NULL DEFAULT '',location TEXT NOT NULL DEFAULT 'Hybrid',phone TEXT NOT NULL DEFAULT '',emergency_contact TEXT NOT NULL DEFAULT '',start_date TEXT NOT NULL DEFAULT '',salary INTEGER NOT NULL DEFAULT 0,salary_currency TEXT NOT NULL DEFAULT 'INR',annual_ctc_paise INTEGER NOT NULL DEFAULT 0,employee_code TEXT NOT NULL DEFAULT '',exit_date TEXT NOT NULL DEFAULT '');
    CREATE TABLE invites(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,title TEXT NOT NULL,department TEXT NOT NULL,location TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),used_at TEXT);
    CREATE TABLE requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,details TEXT NOT NULL,start_date TEXT,end_date TEXT,days REAL,status TEXT NOT NULL DEFAULT 'Pending',decision_note TEXT NOT NULL DEFAULT '',decided_by TEXT REFERENCES users(id),created_at TEXT NOT NULL,decided_at TEXT,leave_type TEXT NOT NULL DEFAULT '',payroll_leave_status TEXT NOT NULL DEFAULT '');
    CREATE TABLE leave_rules(id TEXT PRIMARY KEY,name TEXT NOT NULL,annual_days REAL NOT NULL DEFAULT 0,sick_days REAL NOT NULL DEFAULT 0,notes TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
    CREATE TABLE attendance(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),work_date TEXT NOT NULL,segments TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'out',admin_status TEXT NOT NULL DEFAULT '',admin_note TEXT NOT NULL DEFAULT '',admin_updated_by TEXT REFERENCES users(id),admin_updated_at TEXT,UNIQUE(user_id,work_date));
    CREATE TABLE calendar_events(id TEXT PRIMARY KEY,title TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT,kind TEXT NOT NULL DEFAULT 'event',description TEXT NOT NULL DEFAULT '',approved INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,due_date TEXT,status TEXT NOT NULL DEFAULT 'To do',created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE activity_logs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
    CREATE TABLE audit_logs(id TEXT PRIMARY KEY,actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,entity TEXT NOT NULL,entity_id TEXT NOT NULL DEFAULT '',details TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
    CREATE TABLE notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,body TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'info',entity_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,read_at TEXT);
  `);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "macrow-attendance-payroll-test-"));
  initUpgrades(db, folder);

  // Setup admin and employee
  db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)").run(
    "a1", "admin@example.test", "Admin User", "admin", "2026-01-01T00:00:00.000Z"
  );
  db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)").run(
    "u1", "employee@example.test", "Test Employee", "employee", "2026-01-01T00:00:00.000Z"
  );
  db.prepare("INSERT INTO employees(user_id,start_date,annual_ctc_paise) VALUES(?,?,?)").run(
    "u1", "2026-08-01", 18000000
  );

  const policy = {
    id: "pol-test",
    name: "Attendance Deduction Enabled Policy",
    code: "POL-ATT",
    status: "Active",
    version: 1,
    effective_from: "2020-01-01",
    effective_to: null,
    salary_calculation_method: "calendar_days",
    fixed_divisor: 30,
    custom_divisor: 30,
    weekly_off_days_json: "[0,6]",
    weekly_offs_paid: 1,
    sandwich_weekly_offs: 0,
    weekly_offs_in_divisor: 1,
    holidays_paid: 1,
    sandwich_holidays: 0,
    proration_method: "calendar_days",
    leave_deduction_divisor_method: "calendar_days",
    unpaid_leave_enabled: 1,
    half_day_factor: 0.5,
    late_deduction_enabled: 0,
    late_grace_minutes: 15,
    late_penalty_paise: 0,
    attendance_deduction_enabled: 1,
    custom_rules_json: "[]",
  };

  const structure = {
    id: "s1",
    user_id: "u1",
    effective_from: "2026-08-01",
    basic_paise: 750000,
    allowances_json: JSON.stringify([
      { name: "HRA", amount_paise: 300000 },
      { name: "Telephone & Internet", amount_paise: 190000 },
      { name: "Other Allowance", amount_paise: 260000 }
    ]),
    earnings_json: "[]",
    deductions_json: "[]",
    workday_method: "calendar_days",
    weekly_offs_json: "[0,6]",
    paid_leave_entitlement: 12,
  };

  const categories = [
    { name: "Paid", category: "Paid", entitlement_days: 12 },
    { name: "Unpaid", category: "Unpaid", entitlement_days: 0 },
  ];

  const user = { id: "u1", name: "Test Employee" };
  const employee = { id: "u1", name: "Test Employee", start_date: "2026-08-01", exit_date: "", annual_ctc_paise: 18000000 };

  return {
    db,
    folder,
    user,
    employee,
    policy,
    structure,
    categories,
    calculate(period = "2026-08", bounds = { start_date: "2026-08-01", end_date: "2026-08-30" }) {
      return calculateEmployee(user, employee, structure, period, categories, policy, bounds);
    },
    markAttendance(work_date, admin_status = "present", segments = []) {
      db.prepare(`
        INSERT INTO attendance(id,user_id,work_date,segments,status,admin_status)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(user_id,work_date) DO UPDATE SET admin_status=excluded.admin_status, segments=excluded.segments
      `).run(`att-${work_date}`, "u1", work_date, JSON.stringify(segments), "out", admin_status);
    },
    addLeave(id, start, end = start, type = "Paid", payrollStatus = "Paid", days = null) {
      const calcDays = days != null ? days : (start === end ? 1 : 2);
      db.prepare(
        "INSERT INTO requests(id,user_id,kind,details,start_date,end_date,days,status,created_at,leave_type,payroll_leave_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
      ).run(id, "u1", "Leave", "Leave request", start, end, calcDays, "Approved", `${start}T00:00:00.000Z`, type, payrollStatus);
    },
    close() {
      db.close();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  };
}

test("Zero attendance records do not create automatic absence deductions (August 2026 Scenario)", (t) => {
  const f = fixture();
  t.after(() => f.close());

  // Period: 1–30 August 2026 (30 calendar days, 10 weekly offs)
  // Attendance is NOT recorded.
  const result = f.calculate("2026-08", { start_date: "2026-08-01", end_date: "2026-08-30" });

  assert.equal(result.calendar_days, 31, "Calendar length of August is 31");
  assert.equal(result.payable_days, 30, "All 30 eligible employment days must be payable");
  assert.equal(result.gross_paise, 1451613, "Gross must be ₹14,516.13 (1451613 paise)");
  assert.equal(result.leave_deduction_paise, 0, "Leave deduction must be 0");
  assert.equal(result.other_deductions_json, "[]", "No other deductions");
  assert.equal(result.total_deductions_paise, 0, "Total deductions must be 0");
  assert.equal(result.net_paise, 1451613, "Net payable must equal gross (₹14,516.13)");
  assert.equal(result.attendance_completeness, "Not recorded");

  // Verify that an administrator review warning is raised
  const warnings = result.validation.filter((v) => v.code === "attendance_not_recorded");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /Administrator review required/);
});

test("Verified unpaid absence creates the correct deduction", (t) => {
  const f = fixture();
  t.after(() => f.close());

  // Mark 1 day as explicitly verified absent by Admin
  f.markAttendance("2026-08-05", "absent");

  const result = f.calculate("2026-08", { start_date: "2026-08-01", end_date: "2026-08-30" });

  // 1 verified absent day with leave divisor 31: 1,500,000 / 31 = 48,387.09 => 48,387 paise (₹483.87)
  const expectedDeduction = Math.round(1500000 / 31);
  const otherDeductions = JSON.parse(result.other_deductions_json);

  assert.equal(otherDeductions.length, 1);
  assert.equal(otherDeductions[0].name, "Attendance Deduction");
  assert.equal(otherDeductions[0].amount_paise, expectedDeduction);
  assert.equal(result.total_deductions_paise, expectedDeduction);
  assert.equal(result.payable_days, 29, "Payable days reduced by 1 verified absent day");
  assert.equal(result.net_paise, result.gross_paise - expectedDeduction);
});

test("Paid leave creates no unpaid deduction", (t) => {
  const f = fixture();
  t.after(() => f.close());

  // Add 2 days of approved Paid leave
  f.addLeave("l1", "2026-08-10", "2026-08-11", "Paid", "Paid");

  const result = f.calculate("2026-08", { start_date: "2026-08-01", end_date: "2026-08-30" });

  assert.equal(result.paid_leave_days, 2);
  assert.equal(result.unpaid_leave_days, 0);
  assert.equal(result.leave_deduction_paise, 0);
  assert.equal(result.total_deductions_paise, 0);
  assert.equal(result.payable_days, 30);
  assert.equal(result.net_paise, result.gross_paise);
});

test("Weekly offs are not treated as absences", (t) => {
  const f = fixture();
  t.after(() => f.close());

  // In 1–30 August 2026, there are 10 weekly offs (Saturdays & Sundays).
  // No attendance recorded on any day.
  const result = f.calculate("2026-08", { start_date: "2026-08-01", end_date: "2026-08-30" });

  const calc = JSON.parse(result.calculation_json);
  assert.equal(calc.weekly_offs, 10);
  assert.equal(calc.paid_weekly_off_days, 10);
  // Weekly offs are never included in missing attendance dates
  for (const dateStr of calc.missing_attendance_dates) {
    const dayOfWeek = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
    assert.notEqual(dayOfWeek, 0, "Sunday must not be in missing attendance dates");
    assert.notEqual(dayOfWeek, 6, "Saturday must not be in missing attendance dates");
  }
});

test("Missing attendance triggers an admin review warning and completeness indicator", (t) => {
  const f = fixture();
  t.after(() => f.close());

  // Case 1: Zero attendance records -> "Not recorded"
  const res1 = f.calculate("2026-08", { start_date: "2026-08-01", end_date: "2026-08-30" });
  assert.equal(res1.attendance_completeness, "Not recorded");
  assert.ok(res1.validation.some((v) => v.code === "attendance_not_recorded"));

  // Case 2: Some days present, some missing -> "Partially recorded"
  f.markAttendance("2026-08-03", "present", [{ start: "2026-08-03T10:00:00Z", end: "2026-08-03T19:00:00Z" }]);
  const res2 = f.calculate("2026-08", { start_date: "2026-08-01", end_date: "2026-08-30" });
  assert.equal(res2.attendance_completeness, "Partially recorded");
  assert.ok(res2.validation.some((v) => v.code === "attendance_partially_recorded"));
});

test("Incomplete attendance cannot silently produce finalized payroll; requires admin decision", async (t) => {
  const f = fixture();
  t.after(() => f.close());

  const db = f.db;
  db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)").run(
    "hr1", "hr@example.test", "HR Manager", "hr_manager", "2026-01-01T00:00:00.000Z"
  );
  db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)").run(
    "pm1", "pm@example.test", "Payroll Manager", "payroll_manager", "2026-01-01T00:00:00.000Z"
  );
  db.prepare("INSERT INTO salary_structures(id,user_id,effective_from,basic_paise,allowances_json,workday_method,weekly_offs_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(
    "s1", "u1", "2026-08-01", 750000, f.structure.allowances_json, "calendar_days", "[0,6]", "a1", "2026-08-01T00:00:00Z"
  );
  db.prepare("INSERT INTO payroll_periods(id,period,period_start_date,period_end_date,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(
    "p1", "2026-08", "2026-08-01", "2026-08-30", "Payroll Approval", "a1", "2026-08-31T00:00:00Z", "2026-08-31T00:00:00Z"
  );

  // Recalculate draft to populate items
  db.prepare("UPDATE payroll_periods SET status='Validation' WHERE id='p1'").run();
  recalcPeriod("p1", "a1");
  db.prepare("UPDATE payroll_periods SET status='Payroll Approval', hr_reviewer='hr1' WHERE id='p1'").run();

  const periodBefore = serializePeriod(db.prepare("SELECT * FROM payroll_periods WHERE id='p1'").get());
  assert.equal(periodBefore.attendance_completeness, "Not recorded");

  // Helper to simulate API transition call
  async function simulateTransition(payload, user) {
    let responseStatus = 200;
    let responseBody = null;
    const { Readable } = require("node:stream");
    const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
    Object.assign(req, {
      method: "POST",
      url: `/api/hrm/payroll/periods/p1/transition`,
      headers: { "content-type": "application/json" },
      socket: { remoteAddress: "127.0.0.1" }
    });

    const res = {
      setHeader() {},
      end(data) {
        if (data) responseBody = JSON.parse(data);
      }
    };
    const json = (r, status, data) => {
      responseStatus = status;
      responseBody = data;
    };

    try {
      await routeUpgrade(req, res, new URL(`http://localhost${req.url}`), user, json);
    } catch (e) {
      responseStatus = e.status || 500;
      responseBody = { error: e.message };
    }
    return { status: responseStatus, body: responseBody };
  }

  const pmUser = { id: "pm1", role: "payroll_manager" };

  // Attempt 1: Finalize without override -> Must be rejected with 409
  const res1 = await simulateTransition({ to: "Finalized", note: "Attempting to finalize" }, pmUser);
  assert.equal(res1.status, 409, "Must reject finalization when attendance is incomplete");
  assert.match(res1.body.error, /Incomplete attendance cannot silently produce finalized payroll/);

  // Attempt 2: Finalize with override but insufficient reason -> Must be rejected
  const res2 = await simulateTransition({ to: "Finalized", note: "Override", attendance_override: true, override_reason: "ab" }, pmUser);
  assert.equal(res2.status, 409, "Must reject finalization when override reason is too short");

  // Attempt 3: Finalize with explicit administrator decision / override reason
  const validReason = "Attendance verified through physical sign-in registers by HR.";
  const res3 = await simulateTransition({
    to: "Finalized",
    note: "Final signoff",
    attendance_override: true,
    override_reason: validReason
  }, pmUser);

  assert.equal(res3.status, 200, "Finalization must succeed with valid override");
  const periodAfter = db.prepare("SELECT * FROM payroll_periods WHERE id='p1'").get();
  assert.equal(periodAfter.status, "Finalized");
  assert.equal(periodAfter.attendance_override, 1);
  assert.equal(periodAfter.attendance_override_reason, validReason);

  // Verify audit log has the override entry
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action LIKE '%attendance override%'").get();
  assert.ok(audit, "Audit log must record the attendance override");
  assert.equal(audit.details, validReason);
});

test("Manual adjustments are audited and preserved on finalized payroll", async (t) => {
  const f = fixture();
  t.after(() => f.close());

  const db = f.db;
  db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)").run(
    "pm1", "pm@example.test", "Payroll Manager", "payroll_manager", "2026-01-01T00:00:00.000Z"
  );
  db.prepare("INSERT INTO salary_structures(id,user_id,effective_from,basic_paise,allowances_json,workday_method,weekly_offs_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(
    "s1", "u1", "2026-08-01", 750000, f.structure.allowances_json, "calendar_days", "[0,6]", "a1", "2026-08-01T00:00:00Z"
  );
  db.prepare("INSERT INTO payroll_periods(id,period,period_start_date,period_end_date,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(
    "p1", "2026-08", "2026-08-01", "2026-08-30", "Validation", "a1", "2026-08-31T00:00:00Z", "2026-08-31T00:00:00Z"
  );
  recalcPeriod("p1", "a1");
  // Set to Finalized
  db.prepare("UPDATE payroll_periods SET status='Finalized' WHERE id='p1'").run();

  // Try to recalculate finalized period -> Must fail
  const recalcResult = recalcPeriod("p1", "a1");
  assert.equal(recalcResult, false, "Recalculation cannot run on finalized payroll");

  // Record an adjustment
  const item = db.prepare("SELECT * FROM payroll_items WHERE period_id='p1'").get();
  const { Readable } = require("node:stream");

  let responseStatus = 200;
  let responseBody = null;
  const payload = { amount: 500, reason: "Incentive approved by director" };
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  Object.assign(req, {
    method: "POST",
    url: `/api/hrm/payroll/items/${item.id}/adjustments`,
    headers: { "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" }
  });

  const res = { setHeader() {}, end(data) { if (data) responseBody = JSON.parse(data); } };
  const json = (r, status, data) => { responseStatus = status; responseBody = data; };

  await routeUpgrade(req, res, new URL(`http://localhost${req.url}`), { id: "pm1", role: "payroll_manager" }, json);

  assert.equal(responseStatus, 201);
  const adjustment = db.prepare("SELECT * FROM payroll_adjustments WHERE payroll_item_id=?").get(item.id);
  assert.ok(adjustment);
  assert.equal(adjustment.amount_paise, 50000); // 500 INR = 50000 paise
  assert.equal(adjustment.reason, "Incentive approved by director");

  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='Recorded payroll adjustment'").get();
  assert.ok(audit, "Manual adjustment must be audited");
});
