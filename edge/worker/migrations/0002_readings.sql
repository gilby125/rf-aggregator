-- Rolling time-series history for the 24h charts. Written by bridgeIngest on each
-- sync; UNIQUE(sensor_id, ts) dedupes repeated snapshots to one row per reading.
-- Pruned to ~48h in the ingest path.
CREATE TABLE readings (
  sensor_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  temperature_F REAL,
  humidity REAL,
  UNIQUE(sensor_id, ts)
);
CREATE INDEX idx_readings_ts ON readings(ts);
