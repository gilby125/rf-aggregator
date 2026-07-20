-- 0002's readings table had one column per metric (temperature_F, humidity), which silently
-- discarded every other field. Airmon reports temperature_C/pm25/pm10 and got a row with
-- temperature_F NULL — enough to pass the chart's sensor filter, so it rendered a Temperature
-- chart that could never fill.
--
-- Store a fields blob instead, matching catalog.latest (0001_init.sql) and the rest of the
-- adapter -> bridge path, which is already generic over field names. A new metric then needs
-- no migration. Field names stay unit-qualified per CONTRACTS.md §1 (temperature_C is a
-- distinct series from temperature_F and must never be merged with it).
--
-- Additive, not a recreate: production holds ~8.9k rows of real 48h history across 29 sensors.
-- ADD COLUMN is metadata-only in SQLite, and the backfill rebuilds each existing row's blob
-- from its old columns, so no history is lost and the charts stay populated across the deploy.
-- The two legacy columns are left in place (unused, nullable) rather than dropped.
ALTER TABLE readings ADD COLUMN fields TEXT NOT NULL DEFAULT '{}';

UPDATE readings
   SET fields = json_patch(
     CASE WHEN temperature_F IS NOT NULL THEN json_object('temperature_F', temperature_F) ELSE '{}' END,
     CASE WHEN humidity      IS NOT NULL THEN json_object('humidity',      humidity)      ELSE '{}' END
   )
 WHERE fields = '{}';
