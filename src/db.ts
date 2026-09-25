import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.ts";

export type Row = Record<string, unknown>;

export const db = new DatabaseSync(config.paths.db);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS counters (prefix TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  applies_to TEXT NOT NULL DEFAULT '{}',
  meta TEXT NOT NULL DEFAULT '{}',
  current_version_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  content TEXT NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id);

CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  shipment TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]',
  resolution TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  ai_mode TEXT,
  ai_model TEXT,
  ai_result TEXT,
  ai_overall TEXT,
  ai_min_confidence REAL,
  ai_usage TEXT,
  ai_error TEXT,
  ai_started_at TEXT,
  ai_finished_at TEXT,
  routing TEXT,
  human_overall TEXT,
  human_note TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  wms_registered_at TEXT,
  wms_error TEXT,
  case_id TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inspections_created ON inspections(created_at);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_inspection ON photos(inspection_id);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL,
  shipment_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  issue_summary TEXT NOT NULL DEFAULT '',
  issues TEXT NOT NULL DEFAULT '[]',
  email_subject TEXT NOT NULL DEFAULT '',
  email_body TEXT NOT NULL DEFAULT '',
  email_mode TEXT,
  email_sent_at TEXT,
  email_sent_by TEXT,
  reply_token TEXT NOT NULL,
  reply_due_at TEXT,
  reply_choice TEXT,
  reply_text TEXT,
  reply_received_at TEXT,
  reply_channel TEXT,
  instruction TEXT,
  instruction_source TEXT,
  instruction_confidence REAL,
  instruction_summary TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  disposition_skill TEXT,
  worker_instruction TEXT,
  wms_status TEXT,
  executed_at TEXT,
  closed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_events_case ON case_events(case_id);

CREATE TABLE IF NOT EXISTS builder_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  target TEXT NOT NULL,
  materials TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  mode TEXT,
  draft TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL DEFAULT '[]',
  answers TEXT NOT NULL DEFAULT '{}',
  history TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  saved_version_id INTEGER,
  request_id TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_requests (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  customer_id TEXT NOT NULL DEFAULT '',
  inspection_id TEXT,
  example TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_version_id INTEGER,
  draft_version_id INTEGER,
  status TEXT NOT NULL,
  mode TEXT,
  rationale TEXT NOT NULL DEFAULT '',
  change_summary TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',
  test_result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  skill_version_id INTEGER,
  operation TEXT NOT NULL,
  step TEXT NOT NULL,
  selector_key TEXT,
  selector TEXT,
  missing TEXT NOT NULL DEFAULT '[]',
  message TEXT NOT NULL,
  page_url TEXT,
  html_snapshot TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  duration_ms INTEGER,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
`);

function toSql(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params.map(toSql)) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params.map(toSql)) as T | undefined;
}

export function run(sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...params.map(toSql));
}

/** Insert a row from an object; JSON-encodes objects/arrays. */
export function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  return run(sql, ...keys.map((k) => row[k]));
}

/** Update columns of a row identified by its primary key column. */
export function update(table: string, key: string, id: unknown, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ${key} = ?`;
  return run(sql, ...keys.map((k) => patch[k]), id);
}

let txDepth = 0;
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    txDepth--;
  }
}

/** Human-readable sequential IDs such as INSP-000123. */
export function nextId(prefix: string, width = 6): string {
  return tx(() => {
    run(
      "INSERT INTO counters (prefix, value) VALUES (?, 1) ON CONFLICT(prefix) DO UPDATE SET value = value + 1",
      prefix,
    );
    const row = get<{ value: number }>("SELECT value FROM counters WHERE prefix = ?", prefix)!;
    return `${prefix}-${String(row.value).padStart(width, "0")}`;
  });
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
