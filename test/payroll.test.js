"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Readable } = require("node:stream");
const { initUpgrades, calculateEmployee, routeUpgrade } = require("../upgrades");

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
    payrollStatus = "",
  }) {
    db.prepare(
      "INSERT INTO requests(id,user_id,kind,details,start_date,end_date,days,status,created_at,leave_type,payroll_leave_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
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
      payrollStatus,
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
  assert.equal(result.scheduled_days, 21);
});

test("Section 4 Scenario: October 2026, ₹15,000 salary, join 12 Oct, end 30 Oct, calendar-day proration and approved half-day leave", (t) => {
  const f = fixture();
  t.after(() => f.close());

  // Policy: calendar_days, divisor = 31 (for October), paid weekly offs, paid holidays
  const octPolicy = {
    id: "pol-oct-2026",
    name: "October 2026 Test Policy",
    version: 1,
    status: "Active",
    salary_calculation_method: "calendar_days",
    fixed_divisor: 30,
    custom_divisor: 30,
    weekly_off_days_json: "[0,6]",
    weekly_offs_paid: 1,
    holidays_paid: 1,
    proration_method: "calendar_days",
    leave_deduction_divisor_method: "calendar_days",
    unpaid_leave_enabled: 1,
    half_day_factor: 0.5,
    attendance_deduction_enabled: 0,
    custom_rules_json: "[]",
  };

  // Monthly salary: ₹15,000 = 1,500,000 paise
  const salaryStructure = f.structure({
    basic_paise: 750000,
    allowances_json: JSON.stringify([{ name: "Allowance", amount_paise: 750000 }]),
    workday_method: "calendar_days",
  });

  const employee = {
    id: "u1",
    name: "Test Employee",
    start_date: "2026-10-12",
    exit_date: "2026-10-30", // Active calendar days: 12 Oct to 30 Oct = 19 days
  };

  // Case A: Approved Paid half-day leave
  // Expected Prorated salary = 15000 * 19 / 31 = 9193.548... -> 919355 paise (₹9,193.55)
  // Paid leave does NOT deduct
  f.leave({ id: "half-paid", start: "2026-10-15", end: "2026-10-15", days: 0.5, status: "Approved", type: "Paid" });
  const resultPaid = calculateEmployee(
    { id: "u1", name: "Test Employee" },
    employee,
    salaryStructure,
    "2026-10",
    [f.category("Paid", "Paid", 12), f.category("Unpaid", "Unpaid")],
    octPolicy,
  );

  assert.equal(resultPaid.calendar_days, 31);
  assert.equal(resultPaid.paid_leave_days, 0.5);
  assert.equal(resultPaid.unpaid_leave_days, 0);
  assert.equal(resultPaid.leave_deduction_paise, 0);
  assert.equal(resultPaid.gross_paise, 919355); // 15,000 * 19 / 31 = 9,193.55
  assert.equal(resultPaid.net_paise, 919355);

  // Case B: Approved Unpaid half-day leave
  // Half-day deduction = (15000 * 0.5) / 31 = 241.935... -> 24194 paise (₹241.94)
  const fUnpaid = fixture();
  t.after(() => fUnpaid.close());
  fUnpaid.leave({ id: "half-unpaid", start: "2026-10-15", end: "2026-10-15", days: 0.5, status: "Approved", type: "Unpaid" });
  const resultUnpaid = calculateEmployee(
    { id: "u1", name: "Test Employee" },
    employee,
    salaryStructure,
    "2026-10",
    [fUnpaid.category("Paid", "Paid", 12), fUnpaid.category("Unpaid", "Unpaid")],
    octPolicy,
  );

  assert.equal(resultUnpaid.unpaid_leave_days, 0.5);
  assert.equal(resultUnpaid.leave_deduction_paise, 24194);
  assert.equal(resultUnpaid.net_paise, 919355 - 24194); // ₹8,951.61
});

test("Policy engine supports fixed-30 divisor and working-days policies dynamically", (t) => {
  const f = fixture();
  t.after(() => f.close());

  const fixed30Policy = {
    id: "pol-fixed-30",
    name: "Fixed 30 Policy",
    version: 1,
    status: "Active",
    salary_calculation_method: "fixed_30",
    fixed_divisor: 30,
    custom_divisor: 30,
    weekly_off_days_json: "[0,6]",
    weekly_offs_paid: 1,
    holidays_paid: 1,
    proration_method: "calendar_days",
    leave_deduction_divisor_method: "fixed_30",
    unpaid_leave_enabled: 1,
    half_day_factor: 0.5,
    attendance_deduction_enabled: 0,
    custom_rules_json: "[]",
  };

  const salaryStructure = f.structure({
    basic_paise: 1500000, // Monthly salary ₹30,000 = 3,000,000 paise
    allowances_json: JSON.stringify([{ name: "Allowance", amount_paise: 1500000 }]),
    workday_method: "calendar_days",
  });

  const employee = {
    id: "u1",
    name: "Test Employee",
    start_date: "2024-02-01",
    exit_date: "2024-02-29",
  };

  // Full month: ₹30,000, 1 unpaid leave day
  f.leave({ id: "lwp-1", start: "2024-02-12", end: "2024-02-12", days: 1, status: "Approved", type: "Unpaid" });
  const result = calculateEmployee(
    { id: "u1", name: "Test Employee" },
    employee,
    salaryStructure,
    "2024-02",
    [f.category("Paid", "Paid", 12), f.category("Unpaid", "Unpaid")],
    fixed30Policy,
  );

  // Under fixed-30 policy: 3000000 / 30 * 1 = 100000 paise (₹1,000 deduction)
  assert.equal(result.leave_deduction_paise, 100000);
  assert.equal(result.net_paise, 3000000 - 100000);
});

test("October 2026 calendar-day pro-rating covers the seven requested payroll cases", (t) => {
  const policy = {
    id: "active-calendar-policy",
    name: "Active Calendar Day Policy",
    version: 1,
    status: "Active",
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
    attendance_deduction_enabled: 0,
    custom_rules_json: "[]",
  };
  const cases = [
    { name: "two approved paid leaves", join: "2026-10-12", end: "2026-10-30", eligible: 19, leaves: [{ start: "2026-10-13", type: "Paid", payrollStatus: "Paid" }, { start: "2026-10-14", type: "Paid", payrollStatus: "Paid" }], expected: 919355, paidDays: 2, unpaidDays: 0 },
    { name: "zero paid leaves", join: "2026-10-12", end: "2026-10-30", eligible: 19, leaves: [], expected: 919355, paidDays: 0, unpaidDays: 0 },
    { name: "two explicitly paid leaves", join: "2026-10-12", end: "2026-10-30", eligible: 19, leaves: [{ start: "2026-10-13", type: "Unpaid", payrollStatus: "Paid" }, { start: "2026-10-14", type: "Unpaid", payrollStatus: "Paid" }], expected: 919355, paidDays: 2, unpaidDays: 0 },
    { name: "one unpaid leave", join: "2026-10-12", end: "2026-10-30", eligible: 19, leaves: [{ start: "2026-10-15", type: "Paid", payrollStatus: "Unpaid" }], expected: 870968, paidDays: 0, unpaidDays: 1 },
    { name: "full month", join: "2026-10-01", end: "2026-10-31", eligible: 31, leaves: [], expected: 1500000, paidDays: 0, unpaidDays: 0 },
    { name: "joining 15 October", join: "2026-10-15", end: "2026-10-31", eligible: 17, leaves: [], expected: 822581, paidDays: 0, unpaidDays: 0 },
    { name: "half-day unpaid leave", join: "2026-10-12", end: "2026-10-30", eligible: 19, leaves: [{ start: "2026-10-15", days: 0.5, type: "Paid", payrollStatus: "Unpaid" }], expected: 895161, paidDays: 0, unpaidDays: 0.5 },
  ];

  for (const scenario of cases) {
    const f = fixture();
    t.after(() => f.close());
    f.db.prepare("UPDATE employees SET annual_ctc_paise=? WHERE user_id='u1'").run(18000000);
    const structure = f.structure({
      effective_from: "2026-10-01",
      basic_paise: 750000,
      allowances_json: JSON.stringify([{ name: "Allowance", amount_paise: 750000 }]),
      workday_method: "calendar_days",
      weekly_offs_json: "[0,6]",
      paid_leave_entitlement: null,
    });
    for (let i = 0; i < scenario.leaves.length; i++) {
      const leave = scenario.leaves[i];
      f.leave({
        id: `${scenario.name.replaceAll(" ", "-")}-${i}`,
        start: leave.start,
        days: leave.days ?? 1,
        type: leave.type,
        payrollStatus: leave.payrollStatus,
      });
    }
    const result = calculateEmployee(
      { id: "u1", name: "Test Employee" },
      { id: "u1", name: "Test Employee", start_date: scenario.join, exit_date: "", annual_ctc_paise: 18000000 },
      structure,
      "2026-10",
      [f.category("Paid", "Paid", 12), f.category("Unpaid", "Unpaid")],
      policy,
      { start_date: "2026-10-01", end_date: scenario.end },
    );
    assert.equal(result.gross_paise, scenario.join === "2026-10-01" ? 1500000 : scenario.expected + (scenario.unpaidDays === 1 ? 48387 : scenario.unpaidDays === 0.5 ? 24194 : 0), `${scenario.name}: prorated gross`);
    assert.equal(result.paid_leave_days, scenario.paidDays, `${scenario.name}: paid leave days`);
    assert.equal(result.unpaid_leave_days, scenario.unpaidDays, `${scenario.name}: unpaid leave days`);
    assert.equal(result.payable_days, scenario.eligible - scenario.unpaidDays, `${scenario.name}: paid leave is not added twice`);
    assert.equal(result.net_paise, scenario.expected, `${scenario.name}: net pay`);
    assert.equal(result.calculation_json && JSON.parse(result.calculation_json).eligible_employment_days, scenario.join === "2026-10-12" ? 19 : scenario.join === "2026-10-15" ? 17 : 31, `${scenario.name}: inclusive employment days`);
  }
});

test("overlapping approved leave dates are not deducted more than once", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const policy = {
    id: "active-calendar-policy", name: "Active Calendar Day Policy", version: 1,
    salary_calculation_method: "calendar_days", weekly_off_days_json: "[0,6]",
    weekly_offs_paid: 1, holidays_paid: 1, proration_method: "calendar_days",
    leave_deduction_divisor_method: "calendar_days", unpaid_leave_enabled: 1,
    attendance_deduction_enabled: 0,
  };
  const structure = f.structure({
    effective_from: "2026-10-01", basic_paise: 750000,
    allowances_json: JSON.stringify([{ name: "Allowance", amount_paise: 750000 }]),
    workday_method: "calendar_days", weekly_offs_json: "[0,6]", paid_leave_entitlement: null,
  });
  for (const id of ["lwp-one", "lwp-two"])
    f.leave({ id, start: "2026-10-15", type: "Paid", payrollStatus: "Unpaid" });
  const result = calculateEmployee(
    { id: "u1", name: "Test Employee" },
    { id: "u1", name: "Test Employee", start_date: "2026-10-12", exit_date: "2026-10-30" },
    structure,
    "2026-10",
    [f.category("Paid", "Paid", 12), f.category("Unpaid", "Unpaid")],
    policy,
  );
  assert.equal(result.unpaid_leave_days, 1);
  assert.equal(result.leave_deduction_paise, 48387);
  assert.equal(result.net_paise, 870968);
});

test("active Admin payroll policy still controls the divisor and leave deduction method", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const active = f.db.prepare("SELECT id FROM payroll_policies WHERE status='Active' LIMIT 1").get();
  f.db.prepare("UPDATE payroll_policies SET salary_calculation_method='fixed_30', fixed_divisor=30, proration_method='calendar_days', leave_deduction_divisor_method='fixed_30' WHERE id=?").run(active.id);
  const structure = f.structure({
    effective_from: "2026-10-01",
    basic_paise: 750000,
    allowances_json: JSON.stringify([{ name: "Allowance", amount_paise: 750000 }]),
    workday_method: "calendar_days",
    weekly_offs_json: "[0,6]",
    paid_leave_entitlement: null,
  });
  f.leave({ id: "fixed-policy-unpaid", start: "2026-10-15", type: "Unpaid", payrollStatus: "Unpaid" });
  const result = f.calculate("2026-10", structure, [f.category("Paid", "Paid", 12), f.category("Unpaid", "Unpaid")], {
    id: "u1", name: "Test Employee", start_date: "2026-10-12", exit_date: "2026-10-30",
  });
  const calculation = JSON.parse(result.calculation_json);
  assert.equal(calculation.method, "fixed_30");
  assert.equal(calculation.divisor_days, 30);
  assert.equal(calculation.leave_divisor_days, 30);
  assert.equal(result.gross_paise, 950000);
  assert.equal(result.leave_deduction_paise, 50000);
  assert.equal(result.net_paise, 900000);
});

test("approved leave dates before joining are not paid or deducted", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const structure = f.structure({
    effective_from: "2026-10-01",
    basic_paise: 750000,
    allowances_json: JSON.stringify([{ name: "Allowance", amount_paise: 750000 }]),
    workday_method: "calendar_days",
    weekly_offs_json: "[0,6]",
    paid_leave_entitlement: null,
  });
  f.leave({ id: "boundary-leave", start: "2026-10-09", end: "2026-10-12", days: 1, type: "Unpaid", payrollStatus: "Unpaid" });
  const result = calculateEmployee(
    { id: "u1", name: "Test Employee" },
    { id: "u1", name: "Test Employee", start_date: "2026-10-12", exit_date: "2026-10-30" },
    structure,
    "2026-10",
    [f.category("Paid", "Paid", 12), f.category("Unpaid", "Unpaid")],
    {
      id: "active-calendar-policy", name: "Active Calendar Day Policy", version: 1,
      salary_calculation_method: "calendar_days", weekly_off_days_json: "[0,6]",
      weekly_offs_paid: 1, holidays_paid: 1, proration_method: "calendar_days",
      leave_deduction_divisor_method: "calendar_days", unpaid_leave_enabled: 1,
      attendance_deduction_enabled: 0,
    },
  );
  assert.equal(result.unpaid_leave_days, 0);
  assert.equal(result.leave_deduction_paise, 0);
  assert.equal(result.gross_paise, 919355);
  assert.equal(result.net_paise, 919355);
});

test("configured payroll deductions apply fixed and percentage rules through the backend calculator", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const structure = f.structure({
    effective_from: "2024-01-01", basic_paise: 2000000,
    allowances_json: JSON.stringify([{ name: "Allowance", amount_paise: 1000000 }]),
    deductions_json: "[]", workday_method: "calendar_days", weekly_offs_json: "[0,6]",
  });
  const addRule = f.db.prepare(`INSERT INTO payroll_deduction_rules(
    id,company_id,employee_id,name,calculation_method,amount_paise,percentage,percentage_basis,
    frequency,period,effective_from,effective_to,active,created_by,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`);
  addRule.run("fixed-rule", "", null, "Equipment recovery", "fixed", 100000, 0, "gross", "monthly", "", "2024-01-01", null, "u1", "2024-01-01", "2024-01-01");
  addRule.run("percentage-rule", "", "u1", "Pension contribution", "percentage", 0, 10, "basic", "monthly", "", "2024-01-01", null, "u1", "2024-01-01", "2024-01-01");
  addRule.run("one-time-rule", "", "u1", "Advance recovery", "fixed", 25000, 0, "gross", "one_time", "2024-02", "2024-02-01", "2024-02-29", "u1", "2024-01-01", "2024-01-01");
  const result = calculateEmployee(
    { id: "u1", name: "Test Employee" },
    { id: "u1", name: "Test Employee", start_date: "2024-01-01", exit_date: "", annual_ctc_paise: 36000000 },
    structure, "2024-02", [f.category("Paid", "Paid", 12), f.category("Unpaid", "Unpaid")],
    {
      salary_calculation_method: "calendar_days", proration_method: "calendar_days",
      leave_deduction_divisor_method: "calendar_days", weekly_off_days_json: "[0,6]",
      weekly_offs_paid: 1, holidays_paid: 1, unpaid_leave_enabled: 1,
      attendance_deduction_enabled: 0, custom_rules_json: "[]",
    },
  );
  const deductions = JSON.parse(result.other_deductions_json);
  assert.equal(result.gross_paise, 3000000);
  assert.equal(deductions.find((x) => x.name === "Equipment recovery").amount_paise, 100000);
  assert.equal(deductions.find((x) => x.name === "Pension contribution").amount_paise, 200000);
  assert.equal(deductions.find((x) => x.name === "Advance recovery").amount_paise, 25000);
  assert.equal(result.total_deductions_paise, 325000);
  assert.equal(result.net_paise, 2675000);
});

test("attendance deductions honor explicit absent and half-day corrections without duplicating approved leave", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const structure = f.structure({
    effective_from: "2024-01-01", basic_paise: 3000000,
    workday_method: "calendar_days", weekly_offs_json: "[0,6]", paid_leave_entitlement: null,
  });
  const insertAttendance = f.db.prepare("INSERT INTO attendance(id,user_id,work_date,segments,status,admin_status) VALUES(?,?,?,?,?,?)");
  for (let day = 1; day <= 29; day++) {
    const date = `2024-02-${String(day).padStart(2, "0")}`;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if ([0, 6].includes(weekday)) continue;
    if (date === "2024-02-05") insertAttendance.run("absence", "u1", date, "[]", "out", "absent");
    else if (date === "2024-02-06") insertAttendance.run("half-day", "u1", date, "[]", "out", "half_day");
    else insertAttendance.run(`present-${day}`, "u1", date, JSON.stringify([{ start: date === "2024-02-07" ? "2024-02-07T05:00:00Z" : "2024-02-01T03:30:00Z", end: "2024-02-01T17:00:00Z" }]), "out", "");
  }
  const result = calculateEmployee(
    { id: "u1", name: "Test Employee" },
    { id: "u1", name: "Test Employee", start_date: "2024-01-01", exit_date: "" },
    structure, "2024-02", [f.category("Paid", "Paid", 12), f.category("Unpaid", "Unpaid")],
    {
      salary_calculation_method: "calendar_days", proration_method: "calendar_days",
      leave_deduction_divisor_method: "calendar_days", weekly_off_days_json: "[0,6]",
      weekly_offs_paid: 1, holidays_paid: 1, unpaid_leave_enabled: 1,
      attendance_deduction_enabled: 1, half_day_factor: 0.5,
      late_deduction_enabled: 1, shift_start_time: "10:10", late_grace_minutes: 15, late_penalty_paise: 10000,
      custom_rules_json: "[]",
    },
  );
  assert.equal(JSON.parse(result.calculation_json).attendance_loss_units, 1.5);
  assert.equal(JSON.parse(result.calculation_json).late_arrival_count, 1);
  const deductions = JSON.parse(result.other_deductions_json);
  assert.equal(deductions.find((x) => x.name === "Attendance Deduction").amount_paise, Math.round(3000000 * 1.5 / 29));
  assert.equal(deductions.find((x) => x.name === "Late arrival penalty").amount_paise, 10000);
});

test("Admin can create, list, and deactivate a payroll deduction rule through the application API", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const admin = { id: "u1", role: "admin", company_id: "" };
  const call = async (method, route, body = {}) => {
    const req = Readable.from(method === "GET" ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method; req.url = route;
    let result;
    await routeUpgrade(req, {}, new URL(`http://localhost${route}`), admin, (_res, status, data) => { result = { status, data }; return true; });
    return result;
  };
  const created = await call("POST", "/api/hrm/payroll/deduction-rules", {
    name: "Meal recovery", employee_id: "u1", calculation_method: "fixed", frequency: "one_time",
    amount: "250", period: "2024-02", effective_from: "2024-02-01", effective_to: "2024-02-29",
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.rule.amount_paise, 25000);
  assert.equal(created.data.rule.frequency, "one_time");
  const listed = await call("GET", "/api/hrm/payroll/deduction-rules");
  assert.equal(listed.status, 200);
  assert.equal(listed.data.rules.length, 1);
  const disabled = await call("PATCH", `/api/hrm/payroll/deduction-rules/${created.data.rule.id}`, { active: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.rule.active, 0);
  const policy = await call("POST", "/api/hrm/payroll/policies", {
    name: "Late rule test", status: "Draft", effective_from: "2024-01-01", shift_start_time: "09:00",
  });
  assert.equal(policy.status, 201);
  assert.equal(policy.data.policy.shift_start_time, "09:00");
  const update = await call("PUT", `/api/hrm/payroll/policies/${policy.data.policy.id}`, { shift_start_time: "08:30" });
  assert.equal(update.status, 200);
  assert.equal(update.data.policy.shift_start_time, "08:30");
  const rollback = await call("POST", `/api/hrm/payroll/policies/${policy.data.policy.id}/rollback`, { version: 1 });
  assert.equal(rollback.status, 200);
  assert.equal(rollback.data.policy.shift_start_time, "09:00");
});

