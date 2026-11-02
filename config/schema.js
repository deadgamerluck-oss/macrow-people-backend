// PostgreSQL DDL Schema for Neon
module.exports = `
-- Drop tables if needed (for fresh setup/migrations)
-- Users & Core Auth
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin','admin','hr_manager','payroll_manager','manager','employee')),
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'Standard',
  max_employees INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Suspended','Archived')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT 'Hybrid' CHECK(location IN ('Onsite','Remote','Hybrid')),
  phone TEXT NOT NULL DEFAULT '',
  emergency_contact TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL DEFAULT '',
  salary INTEGER NOT NULL DEFAULT 0,
  salary_currency TEXT NOT NULL DEFAULT 'INR',
  employee_code TEXT NOT NULL DEFAULT '',
  exit_date TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  date_of_birth TEXT NOT NULL DEFAULT '',
  responsibilities TEXT NOT NULL DEFAULT '',
  skills_json TEXT NOT NULL DEFAULT '[]',
  manager_id TEXT REFERENCES users(id),
  profile_updated_at TEXT NOT NULL DEFAULT '',
  avatar_data TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  pronouns TEXT NOT NULL DEFAULT '',
  linkedin_url TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL DEFAULT '',
  interests TEXT NOT NULL DEFAULT '',
  certifications_json TEXT NOT NULL DEFAULT '[]',
  annual_ctc_paise BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  department TEXT NOT NULL,
  location TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  used_at TEXT,
  role TEXT NOT NULL DEFAULT 'employee',
  created_at TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  email_status TEXT NOT NULL DEFAULT 'pending',
  correlation_id TEXT NOT NULL DEFAULT '',
  smtp_message_id TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activation_attempts (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL,
  ip TEXT NOT NULL,
  success INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  success INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  segments TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'out',
  admin_status TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  admin_updated_by TEXT REFERENCES users(id),
  admin_updated_at TEXT,
  UNIQUE(user_id, work_date)
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending Verification',
  submitted_at TEXT,
  verified_at TEXT,
  verified_by TEXT REFERENCES users(id),
  review_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS bank_account_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  encrypted_snapshot TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  kind TEXT NOT NULL DEFAULT 'event',
  description TEXT NOT NULL DEFAULT '',
  approved INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'To do',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'Medium',
  start_date TEXT NOT NULL DEFAULT '',
  estimate_hours REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  attachment_url TEXT NOT NULL DEFAULT '',
  review_feedback TEXT NOT NULL DEFAULT '',
  accepted_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_updates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT REFERENCES tasks(id),
  work_date TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'Medium',
  status TEXT NOT NULL DEFAULT 'In Progress',
  progress INTEGER NOT NULL DEFAULT 0,
  completed_today TEXT NOT NULL DEFAULT '',
  pending_work TEXT NOT NULL DEFAULT '',
  blockers TEXT NOT NULL DEFAULT '',
  next_steps TEXT NOT NULL DEFAULT '',
  time_spent REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_update_comments (
  id TEXT PRIMARY KEY,
  update_id TEXT NOT NULL REFERENCES daily_updates(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_update_history (
  id TEXT PRIMARY KEY,
  update_id TEXT NOT NULL REFERENCES daily_updates(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  body TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 1,
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  original_filename TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  file_size BIGINT NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS employee_projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  project TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  responsibility TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active',
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leave_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK(category IN ('Paid','Unpaid')),
  entitlement_days REAL NOT NULL DEFAULT 0,
  allow_half_day INTEGER NOT NULL DEFAULT 1,
  exclude_non_working_days INTEGER NOT NULL DEFAULT 1,
  excess_to_unpaid INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  monthly_accrual_days REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS leave_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  annual_days REAL NOT NULL DEFAULT 0,
  sick_days REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  is_paid INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'info',
  entity_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  details TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  days REAL,
  status TEXT NOT NULL DEFAULT 'Pending',
  decision_note TEXT NOT NULL DEFAULT '',
  decided_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  leave_type TEXT NOT NULL DEFAULT '',
  payroll_leave_status TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  manual_entry INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS salary_structures (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  effective_from TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  basic_paise BIGINT NOT NULL,
  allowances_json TEXT NOT NULL DEFAULT '[]',
  earnings_json TEXT NOT NULL DEFAULT '[]',
  deductions_json TEXT NOT NULL DEFAULT '[]',
  workday_method TEXT NOT NULL DEFAULT 'working_days' CHECK(workday_method IN ('calendar_days','working_days')),
  weekly_offs_json TEXT NOT NULL DEFAULT '[0]',
  paid_leave_entitlement REAL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, effective_from)
);

CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',
  pinned INTEGER NOT NULL DEFAULT 0,
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  image_data TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS payroll_policies (
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
  late_penalty_paise BIGINT NOT NULL DEFAULT 0,
  attendance_deduction_enabled INTEGER NOT NULL DEFAULT 0,
  custom_rules_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payroll_policy_history (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Validation','HR Review','Payroll Approval','Finalized','Published','Paid')),
  calculation_method TEXT NOT NULL DEFAULT 'per_employee',
  validation_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  hr_reviewer TEXT REFERENCES users(id),
  payroll_approver TEXT REFERENCES users(id),
  finalized_by TEXT REFERENCES users(id),
  published_at TEXT,
  paid_at TEXT,
  payment_reference TEXT NOT NULL DEFAULT '',
  period_start_date TEXT NOT NULL DEFAULT '',
  period_end_date TEXT NOT NULL DEFAULT '',
  attendance_completeness TEXT NOT NULL DEFAULT 'Complete',
  attendance_override INTEGER NOT NULL DEFAULT 0,
  attendance_override_reason TEXT NOT NULL DEFAULT '',
  attendance_override_by TEXT REFERENCES users(id),
  attendance_override_at TEXT
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  salary_structure_id TEXT NOT NULL REFERENCES salary_structures(id),
  calendar_days INTEGER NOT NULL,
  scheduled_days REAL NOT NULL,
  present_days REAL NOT NULL,
  paid_leave_days REAL NOT NULL,
  unpaid_leave_days REAL NOT NULL,
  payable_days REAL NOT NULL,
  basic_paise BIGINT NOT NULL,
  allowances_json TEXT NOT NULL,
  earnings_json TEXT NOT NULL,
  gross_paise BIGINT NOT NULL,
  leave_deduction_paise BIGINT NOT NULL,
  other_deductions_json TEXT NOT NULL,
  total_deductions_paise BIGINT NOT NULL,
  net_paise BIGINT NOT NULL,
  calculation_json TEXT NOT NULL,
  validation_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  policy_id TEXT,
  policy_version INTEGER,
  attendance_completeness TEXT NOT NULL DEFAULT 'Complete',
  UNIQUE(period_id, user_id)
);

CREATE TABLE IF NOT EXISTS payroll (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,
  gross BIGINT NOT NULL,
  deductions BIGINT NOT NULL DEFAULT 0,
  net BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',
  paid_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, period)
);

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id TEXT PRIMARY KEY,
  payroll_item_id TEXT NOT NULL REFERENCES payroll_items(id),
  amount_paise BIGINT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payroll_approvals (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES payroll_periods(id),
  stage TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_employee_code ON employees(LOWER(employee_code)) WHERE employee_code <> '';
CREATE INDEX IF NOT EXISTS daily_updates_user_date_idx ON daily_updates(user_id, work_date DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS salary_effective_idx ON salary_structures(user_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_period_status_idx ON payroll_periods(status, period);
CREATE INDEX IF NOT EXISTS payroll_policies_eff_idx ON payroll_policies(status, effective_from DESC);
`;

