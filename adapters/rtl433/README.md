# rtl_433 adapter

Maps rtl_433's native MQTT JSON events into the rf-aggregator event envelope
(docs/CONTRACTS.md §1). The whole adapter is `adapter.conf` — a Telegraf input + one
processor; there is no code.

- Input: `FEED_TOPIC` (default `rtl_433/events`) on `FEED_MQTT_URL`, i.e. run rtl_433 with
  `-F mqtt://<broker>:1883,events`. Band-agnostic: whatever rtl_433 decodes (315/433/868/915;
  weather, TPMS, tank gauges, moisture, alarms, energy) flows through.
- Envelope identity: `id = <model>-<id>[-<channel>]`, `source = rtl433`, `type = sensor`.
- Numeric fields pass through as envelope fields; strings are dropped (contract rule).
- Timestamps: run rtl_433 with `-M time:unix` (or `time:unix:usec:utc`).

## Adding another decoder

Create `adapters/<decoder>/adapter.conf` that yields the same `rf_event` metric shape
(tags `source`, `type`, `id`; numeric fields; correct timestamp) and mount it in
`backend/docker-compose.yml` in place of this one. Everything downstream (grouping,
aggregation, retention, gateway, bridge, edge) is decoder-agnostic. Planned next:
rtlamr (meters), dump1090/readsb (ADS-B), rtl_ais (AIS) — non-sensor domains ride the same
spine but are carried/served, not averaged.
