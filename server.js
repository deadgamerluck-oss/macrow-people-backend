"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const nodemailer = require("nodemailer");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { initUpgrades, routeUpgrade } = require("./upgrades");

// Load environment variables from .env file if present
const envFile = path.join(__dirname, ".env");
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
      )
        val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

function getMailer() {
  if (!process.env.SMTP_HOST) return null;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.SMTP_FROM)
    throw new Error("SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM are required.");
  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("SMTP_PORT must be a valid TCP port.");
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true",
    requireTLS: process.env.SMTP_SECURE !== "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}
const htmlEscape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
function appBaseUrl() {
  const configured = String(process.env.APP_BASE_URL || "").trim();
  const fallback = `http://127.0.0.1:${Number(process.env.PORT) || 3000}`;
  const candidate = configured || fallback;
  let parsed;
  try { parsed = new URL(candidate); } catch { throw new Error("APP_BASE_URL must be a valid absolute URL."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("APP_BASE_URL must be an HTTP(S) origin or base path without credentials, query, or fragment.");
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:")
    throw new Error("APP_BASE_URL must use HTTPS in production.");
  return parsed.toString().replace(/\/+$/, "");
}
async function sendInviteEmail({
  to,
  name,
  inviteUrl,
  role,
  title,
  department,
}) {
  let mailer;
  try { mailer = getMailer(); }
  catch (err) {
    const code = /^[A-Z0-9_]+$/i.test(String(err.code || "")) ? String(err.code).slice(0, 40) : "SMTP_CONFIG";
    return { accepted: false, mode: "smtp", code, error: `${err.message} Correct the server configuration and retry.` };
  }
  const from =
    process.env.SMTP_FROM || "Macrow People <noreply@macrowdigital.com>";
  const base = appBaseUrl(),
    safeName = htmlEscape(name),
    safeTitle = htmlEscape(title),
    safeDepartment = htmlEscape(department),
    safeUrl = htmlEscape(inviteUrl);
  const logoPath = path.join(
    ROOT,
    "public",
    "assets",
    "macrow-digital-logo.png",
  );
  const hasLogo = fs.existsSync(logoPath);
  const logoSrc = hasLogo
    ? "cid:macrow-digital-logo"
    : `${base}/assets/macrow-digital-logo.png`;
  const subject = `Activate Your Macrow People Account`;
  const supportEmail = process.env.SUPPORT_EMAIL || "support@macrowdigital.com";
  const safeSupport = htmlEscape(supportEmail);
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Activate Your Account · Macrow People</title>
  <style>
    @media only screen and (max-width: 680px) {
      .email-container { width: 100% !important; border-radius: 8px !important; }
      .email-header { padding: 22px 24px !important; }
      .email-body { padding: 32px 24px 24px !important; }
      .email-footer { padding: 22px 24px 28px !important; }
      .main-heading { font-size: 25px !important; line-height: 1.3 !important; }
      .body-text { font-size: 18px !important; line-height: 1.6 !important; }
      .action-btn { width: 100% !important; text-align: center !important; padding: 18px 24px !important; font-size: 19px !important; box-sizing: border-box !important; }
      .link-box { font-size: 14px !important; padding: 12px 14px !important; }
      .notice-text { font-size: 15px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:#1e293b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f6fa;padding:36px 12px;">
    <tr>
      <td align="center">
        <!-- Container -->
        <table role="presentation" class="email-container" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:680px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 12px 36px rgba(15,23,42,0.07);">
          <!-- Header -->
          <tr>
            <td class="email-header" style="background:#152447;padding:28px 40px;text-align:left;">
              <img src="${logoSrc}" alt="Macrow Digital" style="max-height:46px;width:auto;display:block;border:0;">
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td class="email-body" style="padding:44px 40px 36px;color:#1e293b;line-height:1.65;">
              <h1 class="main-heading" style="margin:0 0 22px;color:#0f172a;font-size:30px;font-weight:700;line-height:1.28;letter-spacing:-0.5px;">Welcome to Macrow Digital!</h1>
              <p class="body-text" style="margin:0 0 18px;font-size:20px;color:#1e293b;line-height:1.65;">Hello <b>${safeName}</b>,</p>
              <p class="body-text" style="margin:0 0 28px;font-size:20px;color:#334155;line-height:1.65;">
                Your employee account is ready on <b>Macrow People</b>${safeTitle ? ` as <b>${safeTitle}</b>` : ""}${safeDepartment ? ` in the <b>${safeDepartment}</b> team` : ""}. Please activate your account and set your secure password to get started.
              </p>
              <!-- Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:32px 0;">
                <tr>
                  <td align="left">
                    <a class="action-btn" href="${safeUrl}" target="_blank" style="display:inline-block;padding:18px 40px;font-size:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;background:linear-gradient(135deg,#fb4818,#ea380c);box-shadow:0 6px 18px rgba(251,72,24,0.32);letter-spacing:0.2px;">
                      Activate Your Account &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 14px;font-size:18px;color:#64748b;line-height:1.5;">
                If the button above doesn't work, copy and paste this link into your browser:
              </p>
              <p class="link-box" style="margin:0 0 32px;font-size:18px;line-height:1.6;word-break:break-all;background:#f8fafc;padding:16px 20px;border:1px solid #e2e8f0;border-radius:8px;">
                <a href="${safeUrl}" target="_blank" style="color:#e03e13;text-decoration:underline;font-family:monospace,sans-serif;font-size:18px;">${safeUrl}</a>
              </p>
              <!-- Expiry Note -->
              <div style="background:#fff7ed;border-left:4px solid #fb4818;border-radius:6px;padding:16px 20px;margin:28px 0 0;">
                <p class="notice-text" style="margin:0;font-size:16px;color:#9a3412;line-height:1.6;">
                  <b>Security Notice:</b> This single-use link will expire in <b>7 days</b>. Please do not forward or share this email with anyone.
                </p>
              </div>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="email-footer" style="padding:26px 40px 32px;background:#f8fafc;border-top:1px solid #edf2f7;color:#64748b;font-size:15px;line-height:1.6;text-align:left;">
              <p style="margin:0 0 8px;color:#334155;font-weight:600;font-size:16px;">Macrow People HRMS · Macrow Digital</p>
              <p style="margin:0;color:#64748b;">
                Portal: <a href="${base}" style="color:#0284c7;text-decoration:underline;">${base}</a> &nbsp;|&nbsp; Need help? Contact <a href="mailto:${safeSupport}" style="color:#0284c7;text-decoration:underline;">${safeSupport}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  const text = `Hello ${name},\n\nWelcome to Macrow Digital! Your account has been created on Macrow People.\n\nActivate your account and set your password using this link:\n${inviteUrl}\n\nThis one-time link expires in 7 days.\n\nPortal: ${base}\nSupport: ${supportEmail}\n\nRegards,\nMacrow HR Team`;
  if (mailer) {
    try {
      const mailOptions = {
        from,
        to,
        subject,
        html,
        text,
        attachments: hasLogo
          ? [
              {
                filename: "macrow-digital-logo.png",
                path: logoPath,
                cid: "macrow-digital-logo",
              },
            ]
          : [],
      };
      const accepted = await mailer.sendMail(mailOptions);
      if (
        !(accepted.accepted || []).some(
          (x) => String(x).toLowerCase() === String(to).toLowerCase(),
        )
      )
        return {
          accepted: false,
          mode: "smtp",
          error: "The mail service did not accept this address.",
        };
      return { accepted: true, mode: "smtp", sentAt: now(), messageId: accepted.messageId };
    } catch (err) {
      const code = /^[A-Z0-9_]+$/i.test(String(err.code || "")) ? String(err.code).slice(0, 40) : "SMTP_ERROR";
      return {
        accepted: false,
        mode: "smtp",
        error: `Email service could not accept this invitation (${code}). Check the SMTP settings and retry.`,
        code,
      };
    }
  } else {
    console.log(
      `\n[DEMO EMAIL INVITE] Email service is not configured. No invitation email was sent.\n`,
    );
    return {
      accepted: false,
      mode: "demo",
      error:
        "Email is not configured. Copy the secure activation link for this trial, or configure SMTP.",
    };
  }
}

const ROOT = __dirname,
  PUB = path.join(ROOT, "public"),
  DATA = process.env.HRMS_DATA_DIR ? path.resolve(process.env.HRMS_DATA_DIR) : path.join(ROOT, "data");
fs.mkdirSync(DATA, { recursive: true });
try {
  if (process.platform !== "win32") fs.chmodSync(DATA, 0o700);
} catch {}
const db = new DatabaseSync(path.join(DATA, "macrow-people.sqlite"));
try {
  if (process.platform !== "win32")
    fs.chmodSync(path.join(DATA, "macrow-people.sqlite"), 0o600);
} catch {}
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','employee')), password_hash TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS employees(user_id TEXT PRIMARY KEY REFERENCES users(id), title TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT 'Hybrid' CHECK(location IN ('Onsite','Remote','Hybrid')), phone TEXT NOT NULL DEFAULT '', emergency_contact TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL DEFAULT '', salary INTEGER NOT NULL DEFAULT 0, salary_currency TEXT NOT NULL DEFAULT 'INR');
CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, department TEXT NOT NULL, location TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), used_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attendance(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), work_date TEXT NOT NULL, segments TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'out', UNIQUE(user_id,work_date));
CREATE TABLE IF NOT EXISTS activity_logs(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leave_rules(id TEXT PRIMARY KEY, name TEXT NOT NULL, annual_days REAL NOT NULL DEFAULT 0, sick_days REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, details TEXT NOT NULL, start_date TEXT, end_date TEXT, days REAL, status TEXT NOT NULL DEFAULT 'Pending', decision_note TEXT NOT NULL DEFAULT '', decided_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, decided_at TEXT);
CREATE TABLE IF NOT EXISTS updates(id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'all', pinned INTEGER NOT NULL DEFAULT 0, author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'To do', created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calendar_events(id TEXT PRIMARY KEY, title TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT, kind TEXT NOT NULL DEFAULT 'event', description TEXT NOT NULL DEFAULT '', approved INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payroll(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), period TEXT NOT NULL, gross INTEGER NOT NULL, deductions INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Draft', paid_at TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, UNIQUE(user_id,period));
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, body TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1, author_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, ip TEXT NOT NULL, success INTEGER NOT NULL, created_at TEXT NOT NULL);`);
initUpgrades(db, DATA);

const now = () => new Date().toISOString(),
  id = () => crypto.randomUUID(),
  hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const zone = process.env.APP_TIMEZONE || "Asia/Kolkata";
const isoDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const q = (sql, ...args) => db.prepare(sql).get(...args),
  all = (sql, ...args) => db.prepare(sql).all(...args),
  run = (sql, ...args) => db.prepare(sql).run(...args);

function autoProvisionAdmin() {
  const adminEmail = (process.env.SUPER_ADMIN_EMAIL || process.env.ADMIN_EMAIL || "").trim();
  const adminPassword = (process.env.SUPER_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "").trim();
  const adminName = (process.env.SUPER_ADMIN_NAME || process.env.ADMIN_NAME || "Super Admin").trim();

  if (!adminEmail || !adminPassword) return;

  const existingAdmin = q("SELECT id, email, password_hash FROM users WHERE role='admin' LIMIT 1");
  if (existingAdmin) {
    if (process.env.SYNC_ADMIN_CREDENTIALS === "true") {
      const storedHash = passwordHash(adminPassword);
      run("UPDATE users SET email=?, name=?, password_hash=?, active=1 WHERE id=?", adminEmail.toLowerCase(), adminName, storedHash, existingAdmin.id);
      console.log(`[AUTH] Super Admin credentials synced for ${adminEmail.toLowerCase()}`);
    }
    return;
  }

  const existingUser = q("SELECT id FROM users WHERE lower(email)=lower(?)", adminEmail);
  const storedHash = passwordHash(adminPassword);
  const uid = existingUser ? existingUser.id : id();

  db.exec("BEGIN IMMEDIATE");
  try {
    if (existingUser) {
      run("UPDATE users SET name=?, role='admin', password_hash=?, active=1 WHERE id=?", adminName, storedHash, uid);
    } else {
      run("INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)", uid, adminEmail.toLowerCase(), adminName, "admin", storedHash, now());
      run("INSERT OR IGNORE INTO employees(user_id) VALUES(?)", uid);
    }
    audit(uid, "Auto-provisioned Super Admin from environment", "user", uid, "System startup bootstrap");
    db.exec("COMMIT");
    console.log(`[AUTH] Super Admin provisioned automatically from environment: ${adminEmail.toLowerCase()}`);
  } catch (err) {
    db.exec("ROLLBACK");
    console.error(`[AUTH] Failed to auto-provision Super Admin: ${err.message}`);
  }
}
autoProvisionAdmin();
function nextEmployeeCode() {
  const used = new Set(all("SELECT employee_code FROM employees WHERE employee_code<>''").map((row) => String(row.employee_code).toUpperCase()));
  let sequence = all("SELECT employee_code FROM employees").reduce((max, row) => {
    const match = String(row.employee_code || "").match(/^MAC-EMP-(\d+)$/i);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  let code;
  do { sequence += 1; code = `MAC-EMP-${String(sequence).padStart(4, "0")}`; } while (used.has(code));
  return code;
}
const secure = process.env.NODE_ENV === "production";
const ALLOWED_ORIGIN = (() => { try { return new URL(appBaseUrl()).origin; } catch { return ""; } })();

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === ALLOWED_ORIGIN) return true;
  if (!secure && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
    return true;
  return false;
}

function handleCors(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    if (isAllowedOrigin(origin)) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      });
      res.end();
      return true;
    }
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Origin not allowed." }));
    return true;
  }
  return false;
}

function json(res, status, obj, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://macrow-people-1.onrender.com https://people.macrowdigital.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  res.end(JSON.stringify(obj));
}
function cookie(res, token, maxAge = 28800) {
  let name = secure ? "__Host-macrow_session" : "macrow_session";
  const sameSite = secure ? "None" : "Lax";
  const secureAttr = secure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${name}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secureAttr}`,
  );
}
function clearCookie(res) {
  cookie(res, "", 0);
}
function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        let i = x.indexOf("=");
        return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
      }),
  );
}
async function body(req) {
  let chunks = [],
    size = 0,
    limit = req.url.startsWith("/api/documents") ? 14_500_000 : req.url.startsWith("/api/updates") || req.url.includes("/profile") ? 2_500_000 : 1_000_000;
  for await (const c of req) {
    size += c.length;
    if (size > limit)
      throw Object.assign(Error("Request too large"), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw Object.assign(Error("Invalid JSON body"), { status: 400 });
  }
}
function clean(v, max = 5000) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function email(v) {
  return clean(v, 254).toLowerCase();
}
function fail(status, message) {
  throw Object.assign(Error(message), { status });
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
function activity(user, actor, action, details = "") {
  run(
    "INSERT INTO activity_logs VALUES(?,?,?,?,?,?)",
    id(),
    user,
    actor,
    action,
    clean(details, 1000),
    now(),
  );
  audit(actor, action, "attendance", user, details);
}
function currentUser(req) {
  const c = parseCookies(req),
    token = c["__Host-macrow_session"] || c["macrow_session"];
  if (!token) return null;
  const s = q(
    "SELECT user_id,csrf FROM sessions WHERE token_hash=? AND expires_at>? ",
    hash(token),
    now(),
  );
  if (!s) return null;
  const u = q(
    "SELECT id,email,name,role,active FROM users WHERE id=?",
    s.user_id,
  );
  if (!u || !u.active) return null;
  return { ...u, csrf: s.csrf };
}
function auth(req, res, roles) {
  const u = currentUser(req);
  if (!u) {
    json(res, 401, { error: "Please sign in." });
    return null;
  }
  if (roles && !roles.includes(u.role)) {
    json(res, 403, { error: "You do not have permission for this action." });
    return null;
  }
  if (
    !["GET", "HEAD"].includes(req.method) &&
    !req.url.startsWith("/api/logout") &&
    req.headers["x-csrf-token"] !== u.csrf
  ) {
    json(res, 403, { error: "Security token expired. Reload and try again." });
    return null;
  }
  return u;
}
function passwordHash(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 256
  )
    fail(400, "Use a password between 12 and 256 characters.");
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$32768$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
}
function verifyPassword(password, stored) {
  if (typeof password !== "string" || password.length > 256 || !stored)
    return false;
  try {
    let [, N, r, p, saltHex, keyHex] = stored.split("$");
    const salt = Buffer.from(saltHex, "hex"),
      expected = Buffer.from(keyHex, "hex"),
      actual = crypto.scryptSync(password, salt, expected.length, {
        N: Number(N),
        r: Number(r),
        p: Number(p),
        maxmem: 64 * 1024 * 1024,
      });
    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
function loginRateLimited(emailVal, ip) {
  return (
    Number(
      q(
        "SELECT count(*) n FROM login_attempts WHERE created_at>? AND success=0 AND (email=? OR ip=?)",
        new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        emailVal,
        ip,
      )?.n || 0,
    ) >= 8
  );
}
function recordAttempt(emailVal, ip, success) {
  run(
    "INSERT INTO login_attempts(email,ip,success,created_at) VALUES(?,?,?,?)",
    emailVal,
    ip,
    success ? 1 : 0,
    now(),
  );
  run(
    "DELETE FROM login_attempts WHERE created_at<?",
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  );
}
function publicUser(userId) {
  return q(
    `SELECT u.id,u.email,u.name,u.role,e.title,e.department,e.location,e.phone,e.emergency_contact,e.start_date FROM users u LEFT JOIN employees e ON e.user_id=u.id WHERE u.id=?`,
    userId,
  );
}
function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString("base64url"),
    csrf = crypto.randomBytes(24).toString("base64url"),
    created = now();
  run(
    "INSERT INTO sessions VALUES(?,?,?, ?,?)",
    hash(token),
    userId,
    csrf,
    new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    created,
  );
  cookie(res, token);
  return csrf;
}
function dateMinutes() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
}
function addLog(userId, action, details) {
  activity(userId, userId, action, details);
}
async function route(req, res) {
  if (handleCors(req, res)) return;
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  if (req.method === "GET" && p === "/health")
    return json(res, 200, { ok: true });
  if (req.method === "POST" && p === "/api/login") {
    const d = await body(req),
      em = email(d.email),
      ip = req.socket.remoteAddress || "unknown";
    if (loginRateLimited(em, ip))
      return json(res, 429, {
        error: "Too many sign-in attempts. Wait 15 minutes and try again.",
      });
    const u = q("SELECT * FROM users WHERE email=? AND active=1", em);
    const ok = u && verifyPassword(String(d.password || ""), u.password_hash);
    recordAttempt(em, ip, !!ok);
    if (!ok)
      return json(res, 401, { error: "Email or password is incorrect." });
    const csrf = createSession(u.id, res);
    return json(res, 200, { user: publicUser(u.id), csrf });
  }
  if (req.method === "GET" && p === "/api/me") {
    const u = currentUser(req);
    if (!u) return json(res, 200, { user: null });
    return json(res, 200, { user: publicUser(u.id), csrf: u.csrf });
  }
  if (req.method === "POST" && p === "/api/logout") {
    const u = currentUser(req);
    if (u) {
      const c = parseCookies(req);
      const token = c["__Host-macrow_session"] || c["macrow_session"];
      if (token) run("DELETE FROM sessions WHERE token_hash=?", hash(token));
      audit(u.id, "Signed out", "session", u.id);
    }
    clearCookie(res);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/accept-invite") {
    const d = await body(req),
      token = clean(d.token, 128),
      tokenHash = hash(token),
      ip = req.socket.remoteAddress || "unknown",
      since = new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      limited =
        Number(
          q(
            "SELECT count(*) n FROM activation_attempts WHERE created_at>? AND success=0 AND (token_hash=? OR ip=?)",
            since,
            tokenHash,
            ip,
          )?.n || 0,
        ) >= 8;
    if (limited)
      fail(429, "Too many activation attempts. Wait 15 minutes and try again.");
    const inv = q(
      "SELECT * FROM invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
      tokenHash,
      now(),
    );
    if (!inv) {
      run(
        "INSERT INTO activation_attempts(token_hash,ip,success,created_at) VALUES(?,?,0,?)",
        tokenHash,
        ip,
        now(),
      );
      fail(
        400,
        "Invite is invalid or expired. Ask your administrator to resend it.",
      );
    }
    if (q("SELECT id FROM users WHERE lower(email)=lower(?)", inv.email))
      fail(409, "This invitation has already been activated. Sign in or ask an administrator for help.");
    const uid = id();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (q("SELECT id FROM users WHERE lower(email)=lower(?)", inv.email))
        fail(409, "This invitation has already been activated. Sign in or ask an administrator for help.");
      run(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
        uid,
        inv.email,
        inv.name,
        inv.role || "employee",
        passwordHash(d.password),
        now(),
      );
      run(
        "INSERT INTO employees(user_id,title,department,location,start_date,employee_code) VALUES(?,?,?,?,?,?)",
        uid,
        inv.title,
        inv.department,
        inv.location,
        isoDate(),
        inv.role === "admin" ? "" : nextEmployeeCode(),
      );
      run("UPDATE invites SET used_at=? WHERE id=?", now(), inv.id);
      audit(inv.created_by, "Employee accepted invitation", "user", uid);
      run(
        "INSERT INTO activation_attempts(token_hash,ip,success,created_at) VALUES(?,?,1,?)",
        tokenHash,
        ip,
        now(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    const csrf = createSession(uid, res);
    return json(res, 201, { user: publicUser(uid), csrf });
  }

  let user = auth(req, res);
  if (!user) return;
  if (req.method === "POST" && p === "/api/hrm/smtp/test") {
    if (user.role !== "admin") return json(res, 403, { error: "Super Admin only." });
    const correlationId = crypto.randomUUID();
    try {
      const mailer = getMailer();
      if (!mailer) return json(res, 503, { ok: false, correlationId, error: "SMTP_HOST is not configured." });
      await mailer.verify();
      audit(user.id, "SMTP configuration verified", "integration", "smtp", correlationId);
      return json(res, 200, { ok: true, correlationId, message: "SMTP connection and authentication verified." });
    } catch (err) {
      const code = /^[A-Z0-9_]+$/i.test(String(err.code || "")) ? String(err.code).slice(0, 40) : "SMTP_ERROR";
      audit(user.id, "SMTP diagnostic failed", "integration", "smtp", `${correlationId} · ${code}`);
      return json(res, 503, { ok: false, correlationId, error: `SMTP connection failed (${code}). Review the server configuration and retry.` });
    }
  }
  if (await routeUpgrade(req, res, url, user, json)) return;
  if (req.method === "GET" && p === "/api/dashboard") {
    if (user.role === "admin") {
      return json(res, 200, {
        employees: Number(
          q("SELECT count(*) n FROM users WHERE role='employee' AND active=1")
            .n,
        ),
        pending: Number(
          q("SELECT count(*) n FROM requests WHERE status='Pending'").n,
        ),
        clockedIn: Number(
          q(
            "SELECT count(*) n FROM attendance WHERE work_date=? AND status='in'",
            isoDate(),
          ).n,
        ),
        payroll: Number(
          q("SELECT count(*) n FROM payroll WHERE status='Draft'").n,
        ),
        latest: all(
          "SELECT a.action,a.details,a.created_at,u.name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 8",
        ),
      });
    }
    if (user.role === "hr_manager") {
      return json(res, 200, {
        employees: Number(q("SELECT count(*) n FROM users WHERE role='employee' AND active=1").n),
        pendingInvitations: Number(q("SELECT count(*) n FROM invites i LEFT JOIN users u ON lower(u.email)=lower(i.email) WHERE u.id IS NULL AND i.used_at IS NULL AND i.email_status<>'revoked' AND i.expires_at>?", now()).n),
        pendingRequests: Number(q("SELECT count(*) n FROM requests WHERE status='Pending'").n),
        clockedIn: Number(q("SELECT count(*) n FROM attendance WHERE work_date=? AND status='in'", isoDate()).n),
      });
    }
    if (user.role === "payroll_manager") {
      return json(res, 200, {
        payrollByStatus: all("SELECT status,count(*) AS count FROM payroll_periods GROUP BY status ORDER BY status"),
        bankPending: Number(q("SELECT count(*) n FROM bank_accounts WHERE status IN ('Pending Verification','Changes Requested')").n),
        latestPeriod: q("SELECT period,status,updated_at FROM payroll_periods ORDER BY period DESC LIMIT 1") || null,
      });
    }
    if (user.role === "manager") {
      const department = q("SELECT department FROM employees WHERE user_id=?", user.id)?.department || "";
      return json(res, 200, {
        team: Number(q("SELECT count(*) n FROM employees e JOIN users u ON u.id=e.user_id WHERE e.department=? AND u.role='employee' AND u.active=1", department).n),
        clockedIn: Number(q("SELECT count(*) n FROM attendance a JOIN employees e ON e.user_id=a.user_id WHERE e.department=? AND a.work_date=? AND a.status='in'", department, isoDate()).n),
        overdueTasks: Number(q("SELECT count(*) n FROM tasks t JOIN employees e ON e.user_id=t.user_id WHERE e.department=? AND t.due_date<? AND t.status<>'Completed'", department, isoDate()).n),
        blockedUpdates: Number(q("SELECT count(*) n FROM daily_updates d JOIN employees e ON e.user_id=d.user_id WHERE e.department=? AND d.status='Blocked'", department).n),
        pendingRequests: Number(q("SELECT count(*) n FROM requests r JOIN employees e ON e.user_id=r.user_id WHERE e.department=? AND r.status='Pending'", department).n),
      });
    }
    return json(res, 200, {
      tasks: all(
        "SELECT id,title,due_date,status FROM tasks WHERE user_id=? ORDER BY created_at DESC",
        user.id,
      ),
      updates: all(
        "SELECT id,title,body,pinned,created_at FROM updates WHERE audience=? OR audience=? ORDER BY pinned DESC,created_at DESC",
        "all",
        user.id,
      ),
      attendance: q(
        "SELECT * FROM attendance WHERE user_id=? AND work_date=?",
        user.id,
        isoDate(),
      ),
      logs: all(
        "SELECT action,details,created_at FROM activity_logs WHERE user_id=? ORDER BY created_at DESC LIMIT 10",
        user.id,
      ),
    });
  }
  if (req.method === "GET" && p === "/api/employees") {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    return json(res, 200, {
      employees: all(
        "SELECT u.id,u.email,u.name,u.active,e.title,e.department,e.location,e.phone,e.start_date FROM users u LEFT JOIN employees e ON e.user_id=u.id WHERE u.role='employee' ORDER BY u.name",
      ),
    });
  }
  if (req.method === "PATCH" && p.match(/^\/api\/employees\/[\w-]+\/status$/)) {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    const uid = p.split("/")[3],
      d = await body(req),
      active = d.active ? 1 : 0;
    if (!q("SELECT id FROM users WHERE id=? AND role='employee'", uid))
      fail(404, "Employee not found.");
    run("UPDATE users SET active=? WHERE id=?", active, uid);
    if (!active) run("DELETE FROM sessions WHERE user_id=?", uid);
    audit(
      user.id,
      active ? "Reactivated employee" : "Disabled employee",
      "user",
      uid,
    );
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/employees/invite") {
    if (!["admin", "hr_manager"].includes(user.role))
      return json(res, 403, { error: "Admin or HR only." });
    const d = await body(req),
      em = email(d.email),
      name = clean(d.name, 120),
      title = clean(d.title, 120),
      department = clean(d.department, 120),
      location = clean(d.location, 20);
    if (
      !/^\S+@\S+\.\S+$/.test(em) ||
      !name ||
      !["Onsite", "Remote", "Hybrid"].includes(location)
    )
      fail(400, "Check name, email, and location.");
    if (q("SELECT id FROM users WHERE email=?", em))
      fail(409, "A user with this email already exists.");
    if (q("SELECT id FROM invites WHERE lower(email)=lower(?) AND used_at IS NULL AND email_status<>'revoked' LIMIT 1", em))
      fail(409, "An invitation already exists for this email. Retry or resend it from onboarding status.");
    const recent = Number(
      q(
        "SELECT count(*) n FROM invites WHERE created_by=? AND created_at>?",
        user.id,
        new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      )?.n || 0,
    );
    if (recent >= 6)
      fail(
        429,
        "Too many invitations were requested. Wait 15 minutes and try again.",
      );
    const token = crypto.randomBytes(32).toString("base64url"),
      role = clean(d.role, 30) || "employee";
    if (
      !["employee", "hr_manager", "payroll_manager", "manager"].includes(role)
    )
      fail(400, "Choose a supported invite role.");
    const baseUrl = appBaseUrl();
    const inviteId = id(),
      expires = new Date(Date.now() + 7 * 864e5).toISOString(),
      created = now();
    run(
      "INSERT INTO invites(id,email,name,title,department,location,token_hash,expires_at,created_by,used_at,role,created_at,email_status) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?)",
      inviteId,
      em,
      name,
      title,
      department,
      location,
      hash(token),
      expires,
      user.id,
      role,
      created,
      "pending",
    );
    const fullInviteUrl = `${baseUrl}/accept-invite.html#${token}`;
    const correlationId = crypto.randomUUID();
    const delivery = await sendInviteEmail({ to: em, name, inviteUrl: fullInviteUrl, role, title, department });
    run("UPDATE invites SET email_status=?,sent_at=?,correlation_id=?,smtp_message_id=? WHERE id=?", delivery.accepted ? "sent" : "failed", delivery.accepted ? delivery.sentAt : null, correlationId, delivery.messageId || "", inviteId);
    audit(user.id, delivery.accepted ? "Invitation accepted by SMTP" : "Invitation email failed", "invite", inviteId, `correlation ${correlationId} · ${delivery.mode}${delivery.code ? ` · ${delivery.code}` : ""}`);
    return json(res, 201, {
      id: inviteId,
      expiresInDays: 7,
      emailDelivery: { accepted: delivery.accepted, mode: delivery.mode, error: delivery.error || "", correlationId },
      ...(delivery.accepted || d.allowLinkFallback === true ? { activationUrl: fullInviteUrl } : {}),
    });
  }
  const revokeInvite = p.match(/^\/api\/hrm\/invitations\/([\w-]+)\/revoke$/);
  if (req.method === "POST" && revokeInvite) {
    if (!["admin", "hr_manager"].includes(user.role))
      return json(res, 403, { error: "Admin or HR only." });
    const invite = q("SELECT * FROM invites WHERE id=?", revokeInvite[1]);
    if (!invite) fail(404, "Invitation not found.");
    if (invite.used_at || q("SELECT id FROM users WHERE lower(email)=lower(?)", invite.email))
      fail(409, "An activated account cannot be revoked as an invitation.");
    run("UPDATE invites SET token_hash=?,email_status='revoked',expires_at=?,sent_at=NULL WHERE id=?", hash(crypto.randomBytes(32).toString("base64url")), now(), invite.id);
    audit(user.id, "Revoked employee invitation", "invite", invite.id, "Activation link invalidated");
    return json(res, 200, { ok: true, status: "Revoked" });
  }
  if (
    req.method === "POST" &&
    p.match(/^\/api\/hrm\/invitations\/[\w-]+\/resend$/)
  ) {
    if (!["admin", "hr_manager"].includes(user.role))
      return json(res, 403, { error: "Admin or HR only." });
    const payload = await body(req);
    const inviteId = p.split("/")[4],
      invite = q("SELECT * FROM invites WHERE id=?", inviteId);
    if (!invite) fail(404, "Invitation not found.");
    if (q("SELECT id FROM users WHERE lower(email)=lower(?)", invite.email))
      fail(409, "This employee account is already active.");
    const recent = Number(
      q(
        "SELECT count(*) n FROM invites WHERE created_by=? AND created_at>?",
        user.id,
        new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      )?.n || 0,
    );
    if (recent >= 6)
      fail(
        429,
        "Too many invitations were requested. Wait 15 minutes and try again.",
      );
    const token = crypto.randomBytes(32).toString("base64url"),
      created = now(),
      expires = new Date(Date.now() + 7 * 864e5).toISOString();
    const baseUrl = appBaseUrl();
    run(
      "UPDATE invites SET token_hash=?,expires_at=?,created_by=?,created_at=?,sent_at=NULL,email_status='pending',correlation_id='',smtp_message_id='',used_at=NULL WHERE id=?",
      hash(token),
      expires,
      user.id,
      created,
      inviteId,
    );
    const fullInviteUrl = `${baseUrl}/accept-invite.html#${token}`;
    const correlationId = crypto.randomUUID();
    const delivery = await sendInviteEmail({ to: invite.email, name: invite.name, inviteUrl: fullInviteUrl, role: invite.role, title: invite.title, department: invite.department });
    run("UPDATE invites SET email_status=?,sent_at=?,correlation_id=?,smtp_message_id=? WHERE id=?", delivery.accepted ? "sent" : "failed", delivery.accepted ? delivery.sentAt : null, correlationId, delivery.messageId || "", inviteId);
    audit(user.id, delivery.accepted ? "Invitation accepted by SMTP" : "Invitation email failed", "invite", inviteId, `correlation ${correlationId} · ${delivery.mode}${delivery.code ? ` · ${delivery.code}` : ""}`);
    return json(res, 200, {
      emailDelivery: { accepted: delivery.accepted, mode: delivery.mode, error: delivery.error || "", correlationId },
      expiresInDays: 7,
      ...(delivery.accepted || payload.allowLinkFallback === true ? { activationUrl: fullInviteUrl } : {}),
    });
  }
  if (req.method === "GET" && p === "/api/leave-rules") {
    return json(res, 200, {
      rules: all("SELECT * FROM leave_rules ORDER BY name"),
    });
  }
  if (req.method === "PUT" && p === "/api/leave-rules") {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    const d = await body(req),
      rules = Array.isArray(d.rules) ? d.rules : [];
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM leave_rules");
      for (const r of rules) {
        if (
          !clean(r.name, 100) ||
          !Number.isFinite(Number(r.annual_days)) ||
          !Number.isFinite(Number(r.sick_days))
        )
          fail(400, "Leave rules need a name and numeric day balances.");
        run(
          "INSERT INTO leave_rules VALUES(?,?,?,?,?,?)",
          id(),
          clean(r.name, 100),
          Number(r.annual_days),
          Number(r.sick_days),
          clean(r.notes, 1000),
          now(),
        );
      }
      audit(user.id, "Updated leave rules", "leave_rules");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return json(res, 200, { rules: all("SELECT * FROM leave_rules") });
  }
  if (req.method === "GET" && p === "/api/requests") {
    const rows =
      user.role === "admin"
        ? all(
            "SELECT r.*,u.name,u.email FROM requests r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC",
          )
        : all(
            "SELECT * FROM requests WHERE user_id=? ORDER BY created_at DESC",
            user.id,
          );
    return json(res, 200, { requests: rows });
  }
  if (req.method === "POST" && p === "/api/requests") {
    const d = await body(req),
      kind = clean(d.kind, 40),
      details = clean(d.details, 2000);
    if (!kind || !details) fail(400, "Request type and details are required.");
    const rid = id();
    run(
      "INSERT INTO requests(id,user_id,kind,details,start_date,end_date,days,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      rid,
      user.id,
      kind,
      details,
      clean(d.start_date, 10) || null,
      clean(d.end_date, 10) || null,
      Number(d.days) || null,
      "Pending",
      now(),
    );
    audit(user.id, "Submitted request", "request", rid, kind);
    return json(res, 201, {
      request: q("SELECT * FROM requests WHERE id=?", rid),
    });
  }
  if (req.method === "POST" && p.match(/^\/api\/requests\/[\w-]+\/decision$/)) {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    const rid = p.split("/")[3],
      d = await body(req),
      status = d.status;
    if (!["Approved", "Rejected"].includes(status))
      fail(400, "Decision must be Approved or Rejected.");
    const r = q("SELECT * FROM requests WHERE id=?", rid);
    if (!r) fail(404, "Request not found.");
    run(
      "UPDATE requests SET status=?,decision_note=?,decided_by=?,decided_at=? WHERE id=?",
      status,
      clean(d.note, 1000),
      user.id,
      now(),
      rid,
    );
    if (status === "Approved" && r.kind === "Leave" && r.start_date)
      run(
        "INSERT INTO calendar_events VALUES(?,?,?,?,?,?,?,?,?)",
        id(),
        `Approved leave · ${publicUser(r.user_id).name}`,
        r.start_date,
        r.end_date,
        "leave",
        r.details,
        1,
        user.id,
        now(),
      );
    audit(user.id, `${status} request`, "request", rid);
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && p === "/api/updates") {
    const rows =
      user.role === "admin"
        ? all("SELECT * FROM updates ORDER BY created_at DESC")
        : all(
            "SELECT * FROM updates WHERE audience=? OR audience=? ORDER BY pinned DESC,created_at DESC",
            "all",
            user.id,
          );
    return json(res, 200, { updates: rows });
  }
  if (req.method === "POST" && p === "/api/updates") {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    const d = await body(req),
      title = clean(d.title, 180),
      bodyText = clean(d.body, 5000),
      audience = clean(d.audience, 80) || "all";
    if (!title || !bodyText) fail(400, "Title and announcement are required.");
    let imageData = clean(d.image_data, 2_000_000);
    if (imageData) {
      const match = imageData.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) fail(400, "Choose a PNG, JPEG, or WebP image.");
      const bytes = Buffer.from(match[2], "base64"), png = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, webp = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
      if (!bytes.length || bytes.length > 1_500_000 || bytes.toString("base64") !== match[2] || !(match[1] === "image/png" && png || match[1] === "image/jpeg" && jpg || match[1] === "image/webp" && webp)) fail(400, "Image must be a valid PNG, JPEG, or WebP up to 1.5 MB.");
    }
    const uid = id();
    run(
      "INSERT INTO updates(id,title,body,audience,pinned,author_id,created_at,image_data) VALUES(?,?,?,?,?,?,?,?)",
      uid,
      title,
      bodyText,
      audience,
      d.pinned ? 1 : 0,
      user.id,
      now(),
      imageData,
    );
    audit(user.id, "Published company update", "update", uid, title);
    const recipients = audience === "all" ? all("SELECT id FROM users WHERE role='employee' AND active=1") : all("SELECT id FROM users WHERE id=? AND role='employee' AND active=1", audience);
    for (const recipient of recipients) run("INSERT INTO notifications(id,user_id,title,body,kind,entity_id,created_at,read_at) VALUES(?,?,?,?,?,?,?,NULL)", id(), recipient.id, title, bodyText.slice(0, 1500), "update", uid, now());
    return json(res, 201, { id: uid });
  }
  if (req.method === "GET" && p === "/api/tasks") {
    return json(res, 200, {
      tasks:
        user.role === "admin"
          ? all(
              "SELECT t.*,u.name FROM tasks t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC",
            )
          : all(
              "SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC",
              user.id,
            ),
    });
  }
  if (req.method === "POST" && p === "/api/tasks") {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    const d = await body(req);
    if (
      !q(
        "SELECT id FROM users WHERE id=? AND role='employee' AND active=1",
        d.user_id,
      )
    )
      fail(400, "Choose an active employee.");
    const tid = id();
    run(
      "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)",
      tid,
      d.user_id,
      clean(d.title, 180),
      clean(d.due_date, 10) || null,
      "To do",
      user.id,
      now(),
      now(),
    );
    audit(user.id, "Assigned task", "task", tid);
    return json(res, 201, { id: tid });
  }
  if (req.method === "PATCH" && p.match(/^\/api\/tasks\/[\w-]+$/)) {
    const tid = p.split("/").pop(),
      d = await body(req),
      t = q("SELECT * FROM tasks WHERE id=?", tid);
    if (!t) fail(404, "Task not found.");
    if (user.role !== "admin" && t.user_id !== user.id)
      return json(res, 403, { error: "This task is not assigned to you." });
    if (!["To do", "In progress", "Done"].includes(d.status))
      fail(400, "Invalid task status.");
    run(
      "UPDATE tasks SET status=?,updated_at=? WHERE id=?",
      d.status,
      now(),
      tid,
    );
    audit(user.id, "Updated task", "task", tid, d.status);
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && p === "/api/calendar") {
    return json(res, 200, {
      events: all(
        "SELECT c.*,u.name FROM calendar_events c JOIN users u ON u.id=c.created_by WHERE c.approved=1 ORDER BY c.start_date",
      ),
      requests:
        user.role === "admin"
          ? all(
              "SELECT r.id,r.user_id,r.start_date,r.end_date,r.status,u.name FROM requests r JOIN users u ON u.id=r.user_id WHERE r.kind='Leave' AND r.status='Pending'",
            )
          : [],
    });
  }
  if (req.method === "POST" && p === "/api/calendar") {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    const d = await body(req),
      title = clean(d.title, 180),
      start = clean(d.start_date, 10),
      end = clean(d.end_date, 10) || start,
      kind = ["event", "holiday"].includes(d.kind) ? d.kind : "event";
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(start) || end < start)
      fail(400, "Enter a valid event and date range.");
    const eid = id();
    run(
      "INSERT INTO calendar_events VALUES(?,?,?,?,?,?,?,?,?)",
      eid,
      title,
      start,
      end,
      kind,
      clean(d.description, 1000),
      1,
      user.id,
      now(),
    );
    audit(user.id, "Created calendar event", "calendar_event", eid);
    return json(res, 201, { id: eid });
  }
  if (req.method === "POST" && p === "/api/attendance/action") {
    const d = await body(req),
      action = clean(d.action, 20),
      date = isoDate();
    let rec = q(
        "SELECT * FROM attendance WHERE user_id=? AND work_date=?",
        user.id,
        date,
      ),
      segments = rec ? JSON.parse(rec.segments) : [];
    if (action === "in") {
      if (rec && rec.status === "in") fail(409, "You are already clocked in.");
      if (rec) fail(409, "You have already completed today’s shift.");
      segments.push({ start: now(), end: null });
      run(
        "INSERT INTO attendance(id,user_id,work_date,segments,status) VALUES(?,?,?,?,?)",
        id(),
        user.id,
        date,
        JSON.stringify(segments),
        "in",
      );
      addLog(user.id, "Clocked in", "Shift started");
    } else if (action === "resume") {
      if (!rec || rec.status !== "out" || !segments.length)
        fail(409, "There is no paused shift to resume.");
      segments.push({ start: now(), end: null });
      run(
        "UPDATE attendance SET segments=?,status='in' WHERE id=?",
        JSON.stringify(segments),
        rec.id,
      );
      addLog(user.id, "Resumed shift", "Timer resumed");
    } else if (action === "out") {
      if (!rec || rec.status !== "in")
        fail(409, "You are not currently clocked in.");
      if (dateMinutes() < 19 * 60 && !clean(d.reason, 500))
        fail(400, "A reason is required to clock out before 7:00 PM.");
      segments[segments.length - 1].end = now();
      run(
        "UPDATE attendance SET segments=?,status='out' WHERE id=?",
        JSON.stringify(segments),
        rec.id,
      );
      addLog(
        user.id,
        "Clocked out",
        clean(d.reason, 500) || "Scheduled end of shift",
      );
    } else fail(400, "Unknown attendance action.");
    return json(res, 200, {
      attendance: q(
        "SELECT * FROM attendance WHERE user_id=? AND work_date=?",
        user.id,
        date,
      ),
      logs: all(
        "SELECT action,details,created_at FROM activity_logs WHERE user_id=? ORDER BY created_at DESC LIMIT 20",
        user.id,
      ),
    });
  }
  if (req.method === "GET" && p === "/api/attendance") {
    const own = url.searchParams.get("user_id");
    if (user.role === "admin" && own)
      return json(res, 200, {
        attendance: all(
          "SELECT a.*,u.name FROM attendance a JOIN users u ON u.id=a.user_id WHERE a.user_id=? ORDER BY work_date DESC LIMIT 60",
          own,
        ),
      });
    if (user.role === "admin")
      return json(res, 200, {
        attendance: all(
          "SELECT a.*,u.name FROM attendance a JOIN users u ON u.id=a.user_id ORDER BY work_date DESC LIMIT 100",
        ),
        logs: all(
          "SELECT l.*,u.name FROM activity_logs l JOIN users u ON u.id=l.user_id ORDER BY created_at DESC LIMIT 100",
        ),
      });
    return json(res, 200, {
      attendance: all(
        "SELECT * FROM attendance WHERE user_id=? ORDER BY work_date DESC LIMIT 60",
        user.id,
      ),
      logs: all(
        "SELECT * FROM activity_logs WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
        user.id,
      ),
    });
  }
  if (req.method === "GET" && p === "/api/profile")
    return json(res, 200, { profile: publicUser(user.id) });
  if (req.method === "PATCH" && p === "/api/profile") {
    const d = await body(req);
    run(
      "UPDATE employees SET phone=?,emergency_contact=? WHERE user_id=?",
      clean(d.phone, 40),
      clean(d.emergency_contact, 160),
      user.id,
    );
    audit(user.id, "Updated personal contact details", "employee", user.id);
    return json(res, 200, { profile: publicUser(user.id) });
  }
  if (req.method === "GET" && p === "/api/payroll") {
    const rows =
      user.role === "admin"
        ? all(
            "SELECT p.*,u.name,u.email FROM payroll p JOIN users u ON u.id=p.user_id ORDER BY period DESC",
          )
        : all(
            "SELECT period,gross,deductions,net,status,paid_at,created_at FROM payroll WHERE user_id=? ORDER BY period DESC",
            user.id,
          );
    return json(res, 200, { payroll: rows });
  }
  if (req.method === "POST" && p === "/api/payroll") {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    const d = await body(req),
      gross = Math.round(Number(d.gross)),
      deductions = Math.round(Number(d.deductions) || 0),
      period = clean(d.period, 7);
    if (
      !q("SELECT id FROM users WHERE id=? AND role='employee'", d.user_id) ||
      !/^\d{4}-\d{2}$/.test(period) ||
      !Number.isSafeInteger(gross) ||
      gross < 0 ||
      !Number.isSafeInteger(deductions) ||
      deductions < 0 ||
      deductions > gross
    )
      fail(
        400,
        "Check employee, month, and gross/deduction amounts (whole INR).",
      );
    const pid = id();
    run(
      "INSERT INTO payroll VALUES(?,?,?,?,?,?,?,?,?,?)",
      pid,
      d.user_id,
      period,
      gross,
      deductions,
      gross - deductions,
      "Draft",
      null,
      user.id,
      now(),
    );
    audit(user.id, "Created payroll record", "payroll", pid, period);
    return json(res, 201, { id: pid, net: gross - deductions });
  }
  if (req.method === "POST" && p.match(/^\/api\/payroll\/[\w-]+\/pay$/)) {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    const pid = p.split("/")[3],
      pay = q("SELECT * FROM payroll WHERE id=?", pid);
    if (!pay) fail(404, "Payroll record not found.");
    run("UPDATE payroll SET status='Paid',paid_at=? WHERE id=?", now(), pid);
    audit(user.id, "Marked payroll paid", "payroll", pid, pay.period);
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && p === "/api/documents") {
    return json(res, 200, {
      documents: all(
        "SELECT id,title,category,body,created_at FROM documents WHERE published=1 ORDER BY created_at DESC",
      ),
    });
  }
  if (req.method === "POST" && p === "/api/documents") {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    const d = await body(req),
      doc = id();
    if (!clean(d.title, 180) || !clean(d.body, 10000))
      fail(400, "Document title and content are required.");
    run(
      "INSERT INTO documents VALUES(?,?,?,?,?,?,?)",
      doc,
      clean(d.title, 180),
      clean(d.category, 100) || "Policy",
      clean(d.body, 10000),
      1,
      user.id,
      now(),
    );
    audit(user.id, "Published policy document", "document", doc);
    return json(res, 201, { id: doc });
  }
  if (req.method === "GET" && p === "/api/audit") {
    if (user.role !== "admin") return json(res, 403, { error: "Admin only." });
    return json(res, 200, {
      logs: all(
        "SELECT a.*,u.name,person.id AS employee_id,person.name AS employee_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN users person ON person.id=CASE WHEN a.entity IN ('employee_profile','bank_account','attendance') THEN a.entity_id WHEN a.entity='request' THEN (SELECT user_id FROM requests WHERE id=a.entity_id) WHEN a.entity='task' THEN (SELECT user_id FROM tasks WHERE id=a.entity_id) WHEN a.entity='salary_structure' THEN (SELECT user_id FROM salary_structures WHERE id=a.entity_id) WHEN a.entity='employee_project' THEN (SELECT user_id FROM employee_projects WHERE id=a.entity_id) WHEN a.entity='payroll_adjustment' THEN (SELECT i.user_id FROM payroll_adjustments x JOIN payroll_items i ON i.id=x.payroll_item_id WHERE x.id=a.entity_id) ELSE NULL END ORDER BY a.created_at DESC LIMIT 500",
      ),
    });
  }
  json(res, 404, { error: "Not found." });
}
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/") || req.url === "/health") {
      await route(req, res);
      return;
    }
    let p = new URL(req.url, "http://localhost").pathname;
    if (p === "/") p = "/index.html";
    const file = path.resolve(PUB, "." + decodeURIComponent(p));
    if (!file.startsWith(PUB + path.sep) && file !== PUB)
      return json(res, 403, { error: "Forbidden." });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      return json(res, 404, { error: "Not found." });
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://macrow-people-1.onrender.com https://people.macrowdigital.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    const requestId = crypto.randomUUID();
    console.error(`[API_ERROR] requestId=${requestId} status=${Number(e.status) || 500} code=${/^[A-Z0-9_]+$/i.test(String(e.code || "")) ? String(e.code).slice(0, 40) : "UNCLASSIFIED"}`);
    json(res, e.status || 500, {
      error: e.status ? e.message : "Request could not be completed.",
      requestId,
    });
  }
});
const isCloudDeployment = Boolean(process.env.RENDER || process.env.NODE_ENV === "production");
const host = (isCloudDeployment && (!process.env.HOST || process.env.HOST === "127.0.0.1" || process.env.HOST === "localhost"))
  ? "0.0.0.0"
  : (process.env.HOST || "127.0.0.1"),
  port = Number(process.env.PORT) || 3000;
async function readHidden(prompt) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function")
    throw new Error("Secure interactive provisioning requires a TTY. Run this command in the deployment terminal.");
  stdout.write(prompt);
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      error ? reject(error) : resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") return finish(new Error("Provisioning cancelled."));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}
async function provisionInitialAdmin() {
  if (q("SELECT id FROM users WHERE role='admin' LIMIT 1"))
    throw new Error("A Super Admin already exists. Initial provisioning is permanently closed.");
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  let name, em;
  try {
    name = clean(await prompt.question("Super Admin name: "), 120);
    em = email(await prompt.question("Work email: "));
  } finally { prompt.close(); }
  if (!name || !/^\S+@\S+\.\S+$/.test(em)) throw new Error("Enter a name and a valid work email.");
  const password = await readHidden("Password (12–256 characters, input hidden): ");
  const confirm = await readHidden("Confirm password (input hidden): ");
  if (password !== confirm) throw new Error("Passwords do not match.");
  const uid = id();
  const storedHash = passwordHash(password);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (q("SELECT id FROM users WHERE role='admin' LIMIT 1"))
      throw new Error("A Super Admin was provisioned concurrently; no account was created.");
    run("INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)", uid, em, name, "admin", storedHash, now());
    run("INSERT INTO employees(user_id) VALUES(?)", uid);
    audit(uid, "Provisioned initial Super Admin", "user", uid, "CLI bootstrap");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  stdout.write("Initial Super Admin created. Restart the service normally to sign in.\n");
}
async function recoverAdminAccess() {
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  let em;
  try { em = email(await prompt.question("Existing Super Admin work email: ")); }
  finally { prompt.close(); }
  const account = q("SELECT id,email FROM users WHERE lower(email)=lower(?) AND role='admin'", em);
  if (!account) throw new Error("No Super Admin account matches that email. Recovery does not create administrator accounts.");
  const password = await readHidden("Replacement password (12–256 characters, input hidden): ");
  const confirm = await readHidden("Confirm replacement password (input hidden): ");
  if (password !== confirm) throw new Error("Passwords do not match.");
  const storedHash = passwordHash(password);
  db.exec("BEGIN IMMEDIATE");
  try {
    run("UPDATE users SET password_hash=?,active=1 WHERE id=? AND role='admin'", storedHash, account.id);
    run("DELETE FROM sessions WHERE user_id=?", account.id);
    audit(account.id, "Recovered Super Admin access", "user", account.id, "Privileged CLI recovery; prior sessions revoked");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  stdout.write("Super Admin password reset; previous sessions revoked. Sign in with the replacement password.\n");
}
if (["provision-admin", "recover-admin"].includes(process.argv[2])) {
  const command = process.argv[2] === "provision-admin" ? provisionInitialAdmin : recoverAdminAccess;
  command().then(() => { db.close(); process.exit(0); }).catch((error) => {
    console.error(error.message);
    db.close();
    process.exit(1);
  });
} else {
  server.listen(port, host, () =>
    console.log(`Macrow People listening at http://${host}:${port}\nDatabase: ${path.join(DATA, "macrow-people.sqlite")}`),
  );
}
process.on("SIGINT", () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
