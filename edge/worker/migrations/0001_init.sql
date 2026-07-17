-- rf-aggregator D1 schema v1 (docs/CONTRACTS.md)
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  sub TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE user_config (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  config TEXT NOT NULL DEFAULT '{}'
);

-- Per-sensor identity + latest values, pushed by the bridge; Path B computes from `latest`.
CREATE TABLE catalog (
  sensor_id TEXT PRIMARY KEY,
  source TEXT,
  type TEXT,
  last_seen INTEGER,
  latest TEXT NOT NULL DEFAULT '{}'
);

-- Admin-owned shared groups; changes bump kv.defs_version and flow down to the backend.
CREATE TABLE group_defs (
  group_name TEXT PRIMARY KEY,
  sensor_ids TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER
);

-- Per-user custom groups (Path B). Stay edge-side in v1.
CREATE TABLE custom_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  sensor_ids TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER,
  UNIQUE(user_id, name)
);

-- Small documents: aggregates_json (Path A payload), defs_version (int as text).
CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT INTO kv (k, v) VALUES ('defs_version', '0');
