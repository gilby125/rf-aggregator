# Contracts (v1)

The three documented, versioned interfaces of rf-aggregator. Backend, edge, adapters, and the
custom-group module depend only on these — each side is independently swappable.

Version: `1`. Every payload that crosses a boundary carries `"v": 1`. Breaking changes bump it.

---

## 1. Event envelope (adapter → aggregator, normalized stream)

The internal model. One adapter per decoder maps native output into this shape; everything
downstream (aggregation, retention, gateway, bridge, edge) sees only envelopes.

```json
{
  "ts":     1752770400.123,        // unix seconds (float ok) — REQUIRED
  "source": "rtl433",              // adapter name — REQUIRED
  "type":   "sensor",              // domain: sensor | meter | position | … — REQUIRED
  "id":     "Acurite-Tower-1234",  // stable sensor identity within source — REQUIRED
  "lat":    null,                  // optional, position domains
  "lon":    null,                  // optional
  "fields": {                      // numeric readings — at least one for type=sensor
    "temperature_F": 72.1,
    "humidity": 40
  }
}
```

Rules:
- `id` must be stable across restarts (rtl433 adapter: `<model>-<id>[-<channel>]`).
- `fields` values are numbers. Non-numeric decoder output is dropped by the adapter, not carried.
- Aggregation (group mean) applies only to `type=sensor`. Other types ride ingest→retain→gateway
  untouched.
- **Adapters are INPUT-ONLY. An adapter config must never declare a processor.** Telegraf
  processors are global — there is no per-adapter namespace, so a processor declared in one
  adapter's file silently rewrites *every* other adapter's metrics. Put source-specific
  processors in `backend/telegraf/telegraf.conf` with an explicit
  `[processors.<name>.tagpass] source = ["<that source>"]`.
  (This is not hypothetical: rtl433's id template ran on airmon envelopes and produced
  `id="-airmon001-026210"` — empty model, leading dash — with no error logged.)
- Field names carry their unit when units can differ across sources (`temperature_C` vs
  `temperature_F`). `aggregators.basicstats` means by field name, so identical names across
  differing units would be averaged into a meaningless value.

**Telegraf metric mapping** (how the envelope lives inside the aggregator): measurement
`rf_event`; tags `source`, `type`, `id`, `group` (added by the id→group lookup, `unassigned` if
unmapped); fields = `fields{…}` (+ `lat`/`lon` when present); metric timestamp = `ts`.

### MQTT topics (backend broker)
| Topic | Payload | Producer |
|---|---|---|
| operator's decoder topic (e.g. `rtl_433/events`) | native decoder JSON | decoder (out of scope) |
| `rf/events/<id>` | envelope-shaped JSON (Telegraf serialized) | aggregator (normalized raw out) |
| `rf/agg/<group>` | per-group aggregate JSON (fields `<name>_mean`) | aggregator (gateway out) |

---

## 2. Backend ↔ edge API (bridge agent ⇄ Worker)

Transport: HTTPS to the Worker. Auth: `Authorization: Bearer <BRIDGE_TOKEN>` (Worker secret).
The bridge is **outbound-only**; the edge never calls the backend.

### `POST /api/bridge/ingest` — push up (every `SYNC_PERIOD`)
```json
{
  "v": 1,
  "catalog": [
    { "id": "Acurite-Tower-1234", "source": "rtl433", "type": "sensor",
      "last_seen": 1752770400, "latest": { "temperature_F": 72.1, "humidity": 40 } }
  ],
  "aggregates": {
    "period_s": 300,
    "groups": {
      "backyard": { "ts": 1752770400, "fields": { "temperature_F_mean": 71.8, "humidity_mean": 42.5 } }
    }
  }
}
```
Response: `{ "v": 1, "ok": true, "defs_version": 7 }`.
Worker upserts `catalog`, replaces latest shared aggregates, refreshes the `/aggregates.json`
document. `defs_version` lets the bridge decide whether to pull defs.

### `GET /api/bridge/defs` — pull down
Response:
```json
{
  "v": 1,
  "defs_version": 7,
  "group_defs": { "backyard": ["Acurite-Tower-1234", "Acurite-Tower-5678"] }
}
```
`group_defs` maps group name → sensor ids (admin-owned, drives the backend id→group mapping).
Per-user custom defs stay edge-side (Path B computes at the edge); they are **not** pulled down in v1.

Bridge behavior on changed `defs_version`: write `mapping.json` + rewrite the version-stamped
snippet in `telegraf.d/` (triggers `--watch-config` reload).

### Public / user endpoints (browser → Worker, Access-gated)
| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /aggregates.json` | none (edge-cached, `s-maxage=AGG_PERIOD`) | **Path A** shared aggregates doc |
| `GET /api/me` | Access JWT | identity + auto-provision user row on first visit |
| `GET /api/catalog` | Access JWT | sensor list (id, source, type, last_seen) for group pickers |
| `GET/PUT /api/config` | Access JWT | per-user config (selected shared groups, prefs) |
| `GET/POST/DELETE /api/custom` | Access JWT | **Path B**: user's custom group defs; GET computes current means on demand from D1 latest |
| `GET/PUT /api/admin/group_defs` | Access JWT + admin | shared group definitions (bumps `defs_version`) |

`/aggregates.json` shape (also what Path A caches):
```json
{ "v": 1, "updated": 1752770400, "period_s": 300,
  "groups": { "backyard": { "ts": 1752770400, "fields": { "temperature_F_mean": 71.8 } } } }
```

Path B `GET /api/custom` response per group:
`{ "name": "mine", "sensor_ids": [...], "computed": { "temperature_F": 71.2 }, "stale_ids": [] }`
(mean of D1 `catalog.latest` values across the group's sensors; `stale_ids` lists sensors not seen
within `2 × period_s`, which are excluded from the mean).

---

## 3. Config schemas

### Backend env (`backend/.env`) — nothing hardcoded
| Var | Default | Meaning |
|---|---|---|
| `FEED_MQTT_URL` | `tcp://mosquitto:1883` | operator's broker carrying the decoded feed |
| `FEED_TOPIC` | `rtl_433/events` | decoder's native-output topic (rtl433 adapter) |
| `AGG_PERIOD` | `5m` | aggregation window / gateway + Path A refresh cadence |
| `SYNC_PERIOD` | `60s` | bridge push/pull cadence |
| `EDGE_URL` | — | Worker base URL (empty = bridge idles, backend still works standalone) |
| `BRIDGE_TOKEN` | — | shared secret for `/api/bridge/*` |
| `INFLUX_URL/ORG/BUCKET/TOKEN/PASSWORD` | see `.env.example` | retention store |

### id→group mapping (bridge → Telegraf, on the shared `telegraf.d` volume)
`mapping.json`: `{ "Acurite-Tower-1234": { "group": "backyard" } }`
(the shape `processors.lookup` consumes: key = envelope `id`, value = tags to add).
Written together with `50-group-mapping.conf`, which embeds `# defs_version: N` so its content
change fires `--watch-config`.

### Edge config (wrangler)
Vars: `TEAM_DOMAIN` (`https://<team>.cloudflareaccess.com`), `POLICY_AUD` (Access app AUD),
`ADMIN_EMAILS` (comma-separated bootstrap admins), `DEV_MODE` (`"1"` skips JWT verify in
`wrangler dev` only). Secrets: `BRIDGE_TOKEN`. Bindings: D1 `DB`, static assets `ASSETS`.

### Opt-in stream shaping (default OFF)
`TRIM_FIELDS` (comma list to drop), `DEDUP_INTERVAL` (suppress unchanged repeats), `DOWNSAMPLE`
(future). All default empty/off per the plan.
