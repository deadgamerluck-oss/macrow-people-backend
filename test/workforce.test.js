"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { initUpgrades, routeUpgrade } = require("../upgrades");

function setup() {
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
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "macrow-workforce-test-"));
  initUpgrades(db, folder);
  const insertUser = db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)");
  insertUser.run("admin", "admin@test.invalid", "Test Admin", "admin", "2026-01-01T00:00:00.000Z");
  insertUser.run("employee", "employee@test.invalid", "Test Employee", "employee", "2026-01-01T00:00:00.000Z");
  insertUser.run("other", "other@test.invalid", "Other Employee", "employee", "2026-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO employees(user_id,title,department,location,start_date) VALUES(?,?,?,?,?)").run("employee", "Designer", "Creative", "Hybrid", "2026-01-01");
  db.prepare("INSERT INTO employees(user_id,title,department,location,start_date) VALUES(?,?,?,?,?)").run("other", "Writer", "Creative", "Remote", "2026-01-01");
  return { db, folder, close() { db.close(); fs.rmSync(folder, { recursive: true, force: true }); } };
}

async function call(user, method, url, payload) {
  const req = { method, url, async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(JSON.stringify(payload)); } };
  const res = {};
  await routeUpgrade(req, res, new URL(`http://local${url}`), user, (_res, status, body) => { res.status = status; res.body = body; return true; });
  return res;
}

test("employee profiles and daily update history are linked and ownership-scoped", async (t) => {
  const f = setup(); t.after(() => f.close());
  const employee = { id: "employee", name: "Test Employee", role: "employee" }, admin = { id: "admin", name: "Test Admin", role: "admin" };
  f.db.prepare("UPDATE employees SET phone=?,emergency_contact=?,address=?,date_of_birth=? WHERE user_id=?").run("+91 98765 43210", "+91 91234 56789", "12 Example Road", "1995-08-14", "employee");
  const profile = await call(employee, "GET", "/api/hrm/employees/employee/profile");
  assert.equal(profile.status, 200); assert.equal(profile.body.employee.email, "employee@test.invalid");
  assert.deepEqual([profile.body.employee.phone, profile.body.employee.emergency_contact, profile.body.employee.address, profile.body.employee.date_of_birth], ["+91 98765 43210", "+91 91234 56789", "12 Example Road", "1995-08-14"]);
  assert.equal("salary" in profile.body.employee, false);
  const saved = await call(employee, "PUT", "/api/hrm/employees/employee/profile", { phone: "+91 90000 11111", emergency_contact: "+91 90000 22222", address: "13 Updated Road", date_of_birth: "1995-08-14" });
  assert.equal(saved.status, 200);
  const updatedProfile = await call(employee, "GET", "/api/hrm/employees/employee/profile");
  assert.equal(updatedProfile.body.employee.phone, "+91 90000 11111");
  assert.equal(updatedProfile.body.employee.address, "13 Updated Road");
  const otherProfile = await call(employee, "GET", "/api/hrm/employees/other/profile");
  assert.equal(otherProfile.status, 403);
  const created = await call(employee, "POST", "/api/hrm/daily-updates", { work_date: "2026-10-15", title: "Design review", description: "Reviewed the first design pass", project: "Website", client: "Internal", priority: "High", status: "Blocked", progress: 45, completed_today: "Reviewed mockups", pending_work: "Finalize assets", blockers: "Waiting for copy", next_steps: "Continue tomorrow", time_spent: 2 });
  assert.equal(created.status, 201);
  const edit = await call(employee, "PUT", `/api/hrm/daily-updates/${created.body.id}`, { work_date: "2026-10-15", title: "Design review", description: "Updated notes", project: "Website", client: "Internal", priority: "High", status: "In Progress", progress: 70, completed_today: "Reviewed mockups", pending_work: "Finalize assets", blockers: "", next_steps: "Continue tomorrow", time_spent: 2 });
  assert.equal(edit.status, 200);
  const otherEdit = await call({ id: "other", role: "employee", name: "Other Employee" }, "PUT", `/api/hrm/daily-updates/${created.body.id}`, { work_date: "2026-10-15", title: "Unauthorized edit", description: "No", status: "In Progress", progress: 50 });
  assert.equal(otherEdit.status, 403);
  const history = await call(employee, "GET", `/api/hrm/daily-updates/${created.body.id}/history`);
  assert.equal(history.body.history.length, 2);
  const feedback = await call(admin, "POST", `/api/hrm/daily-updates/${created.body.id}/comments`, { body: "Please share the revised delivery date." });
  assert.equal(feedback.status, 201);
  const employeeHistory = await call(employee, "GET", "/api/hrm/daily-updates");
  assert.equal(employeeHistory.body.updates[0].comments[0].body, "Please share the revised delivery date.");
  const adminView = await call(admin, "GET", "/api/hrm/daily-updates");
  assert.equal(adminView.body.updates[0].employee_name, "Test Employee");
  const denied = await call(employee, "GET", "/api/hrm/daily-updates?user_id=other");
  assert.equal(denied.status, 403);
});

test("bank details stay encrypted and masked until an authorized reveal; verification is recorded", async (t) => {
  const f = setup(); t.after(() => f.close());
  const employee = { id: "employee", name: "Test Employee", role: "employee" }, admin = { id: "admin", name: "Test Admin", role: "admin" };
  const submitted = await call(employee, "PUT", "/api/hrm/bank", { account_holder: "Test Employee", bank_name: "Example Bank", account_number: "123456789012", account_number_confirm: "123456789012", ifsc: "ABCD0123456", branch_name: "Main", account_type: "Savings", upi_id: "" });
  assert.equal(submitted.status, 200); assert.equal(submitted.body.status, "Pending Verification");
  const masked = await call(employee, "GET", "/api/hrm/bank");
  assert.equal(masked.body.bank.account_number_masked, "••••9012"); assert.equal(JSON.stringify(masked.body).includes("123456789012"), false);
  const stored = f.db.prepare("SELECT ciphertext FROM bank_accounts WHERE user_id='employee'").get();
  assert.equal(stored.ciphertext.includes("123456789012"), false);
  const forbidden = await call(employee, "GET", "/api/hrm/bank?user_id=other");
  assert.equal(forbidden.status, 403);
  const review = await call(admin, "POST", "/api/hrm/bank/review", { user_id: "employee", status: "Verified" });
  assert.equal(review.status, 200);
  const reveal = await call(admin, "POST", "/api/hrm/bank/reveal", { user_id: "employee" });
  assert.equal(reveal.status, 200); assert.equal(reveal.body.bank.account_number, "123456789012");
  const history = await call(admin, "GET", "/api/hrm/bank/history?user_id=employee");
  assert.ok(history.body.history.some(x => x.action === "Verified"));
  const audit = f.db.prepare("SELECT details FROM audit_logs WHERE entity='bank_account'").all();
  assert.equal(JSON.stringify(audit).includes("123456789012"), false);
});
