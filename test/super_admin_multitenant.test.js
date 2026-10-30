const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { initUpgrades, routeUpgrade } = require("../upgrades");

async function call(user, method, url, payload) {
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(JSON.stringify(payload));
    },
  };
  const res = {};
  await routeUpgrade(
    req,
    res,
    new URL(`http://local${url}`),
    user,
    (_res, status, body) => {
      res.status = status;
      res.body = body;
      return true;
    }
  );
  return res;
}

test("Super Admin can create a tenant company with dedicated Company Admin via API", async () => {
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

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "macrow-superadmin-test-"));
  initUpgrades(db, folder);

  const superAdmin = {
    id: "super_admin_id",
    name: "Macrow Super Admin",
    email: "admin@macrowdigital.com",
    role: "super_admin",
  };

  db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)").run(
    superAdmin.id,
    superAdmin.email,
    superAdmin.name,
    superAdmin.role,
    new Date().toISOString()
  );

  // 1. Fetch initial stats
  const statsRes = await call(superAdmin, "GET", "/api/hrm/super-admin/stats");
  assert.equal(statsRes.status, 200);
  assert.equal(statsRes.body.stats.totalCompanies, 0);

  // 2. Create a tenant company
  const createRes = await call(superAdmin, "POST", "/api/hrm/companies", {
    name: "Acme Cloud Solutions",
    domain: "acmecloud.io",
    plan: "Enterprise",
    max_employees: 250,
    admin_name: "Sarah Connors",
    admin_email: "sarah@acmecloud.io",
    admin_password: "AcmeSecurePassword123!",
  });

  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.company.name, "Acme Cloud Solutions");
  assert.equal(createRes.body.company.plan, "Enterprise");
  assert.equal(createRes.body.company.admin.email, "sarah@acmecloud.io");

  // 3. List companies as super_admin
  const listRes = await call(superAdmin, "GET", "/api/hrm/companies");
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.companies.length, 1);
  assert.equal(listRes.body.companies[0].name, "Acme Cloud Solutions");
  assert.equal(listRes.body.companies[0].admin_email, "sarah@acmecloud.io");

  // 4. Update company status (Suspend)
  const patchRes = await call(superAdmin, "PATCH", `/api/hrm/companies/${createRes.body.company.id}`, {
    status: "Suspended",
  });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.company.status, "Suspended");

  db.close();
  fs.rmSync(folder, { recursive: true, force: true });
});
