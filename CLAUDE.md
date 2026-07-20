# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Edge (Cloudflare Worker + UI) — `edge/worker/`
```sh
npm install
npm run check              # tsc --noEmit — the only static check in the repo
npm run db:migrate:local   # apply D1 migrations to the local dev DB
npm run db:migrate         # apply to the REMOTE production D1
npx wrangler dev --ip 0.0.0.0   # 0.0.0.0 so the bridge container can reach it
npm run deploy
```
Local dev needs `cp .dev.vars.example .dev.vars` (`DEV_MODE=1` stubs out Access; identity then
comes from an `x-dev-email` request header — see `identify()` in `src/index.ts`).

### Backend — `backend/`
```sh
cp .env.example .env
docker compose --profile dev up -d --build     # + bundled broker & synthetic rtl_433 feed
docker compose up -d --build                   # against a real decoder feed
docker compose exec mosquitto mosquitto_sub -v -t 'rf/agg/#'    # watch group aggregates
docker compose exec mosquitto mosquitto_sub -v -t 'rf/events/#' # watch normalized envelopes
docker compose --profile dev down -v           # reset all data
```
Profiles: `broker` bundles mosquitto, `dev` adds mosquitto + the `feedgen.sh` synthetic feed.
The bridge is built from source (`backend/bridge/`, Go); `docker compose build bridge` after
editing it.

### Airmon poller — `adapters/airmon/`
Runs on a host in BLE range of the device, not in the backend containers. Needs the **system**
python (`/usr/bin/python3`) — a python without `socket.AF_BLUETOOTH` cannot open the raw ATT
socket. `python3 airmon_poller.py --once` for a single test reading.

### Tests
There is no test suite. `npm run check` (typecheck) and the `--profile dev` synthetic feed are
the verification tools that exist.

## Architecture

Read `docs/CONTRACTS.md` before changing anything that crosses a boundary — the event envelope,
the backend↔edge API, and the config schemas are versioned (`v: 1`) and each side is meant to be
independently swappable.

Data flows: decoder → MQTT → adapter (Telegraf input) → processors → aggregator → InfluxDB +
MQTT gateway → Go bridge → HTTPS → Worker → D1 → UI.

### The group-definition loop (spans five files — the least obvious part of the system)
An admin edits shared groups in the UI, and the change propagates *down* into Telegraf without
anything ever dialing into the backend:

1. `PUT /api/admin/group_defs` (`edge/worker/src/index.ts`) writes `group_defs` and increments
   `kv.defs_version`.
2. The bridge's next `POST /api/bridge/ingest` gets the new `defs_version` back in the response
   (`backend/bridge/main.go`, `sync()`), notices it differs from its cached value, and pulls
   `GET /api/bridge/defs`.
3. `renderMapping()` writes `mapping.json` **first**, then the version-stamped
   `telegraf.d/50-group-mapping.conf`. Order matters: the snippet rewrite is what fires
   Telegraf's `--watch-config`, so the mapping must already be on disk.
4. Telegraf reloads and `processors.lookup` (injected at `order = 2`) tags each envelope with
   its `group`. `processors.lookup` reads its file only at startup — the reload *is* the
   refresh mechanism.
5. `aggregators.basicstats` means per group → `rf/agg/<group>` → the bridge's `onAgg` → back up
   through ingest → `kv.aggregates_json` → `/aggregates.json`.

### Processor chain (`backend/telegraf/telegraf.conf`)
`order=1` rtl433 id template · `order=2` reserved for the bridge-rendered lookup · `order=3`
starlark defaulting unmapped sensors to `group=unassigned` (which is what the UI's "Ungrouped
sensors" section surfaces).

### Two read paths
- **Path A (shared)**: computed once on the backend, served from `/aggregates.json`, edge-cached
  under a host-independent key (`AGG_CACHE_KEY`) so the bridge's purge-on-ingest hits the same
  entry users read. Unauthenticated at the Worker layer — Access is what gates it.
- **Path B (custom)**: `computeCustom()` averages `catalog.latest` in D1 on demand per request.
  Sensors not seen within `2 × period_s` land in `stale_ids` and are excluded from the mean.

### Frontend (`edge/worker/public/`)
No build step, no framework, no CDN — vanilla ES/CSS, Leaflet vendored locally. `app.js` owns
the shell and refreshes every 60s; `radar.js`, `forecast.js`, and `chart.js` are independent
IIFEs that wire themselves to their own DOM ids. Theme is dual-signal
(`prefers-color-scheme` + a `data-theme` attribute for the manual toggle) and persisted both to
`localStorage` and per-user config.

## Load-bearing constraints

**Adapters are INPUT-ONLY. Never put a processor in `adapters/*/adapter.conf`.** Telegraf
processors are global — there is no per-adapter namespace, so a processor declared in one
adapter's file silently rewrites *every other* adapter's metrics. This has already caused real
corruption: rtl433's id template ran on airmon envelopes and produced `id="-airmon001-026210"`
with no error logged. Source-specific processors belong in `backend/telegraf/telegraf.conf`
with an explicit `[processors.<name>.tagpass] source = ["<that source>"]`.

**Field names carry their unit when units differ across sources** (`temperature_C` vs
`temperature_F`). `aggregators.basicstats` means by field name, so identical names spanning
different units would be averaged into a meaningless number.

**`qos = 0` on adapter `mqtt_consumer` inputs.** `qos > 0` makes Telegraf wrap events in
tracking metrics, which breaks the gateway's `outputs.mqtt` topic templates.

**Envelope `id` must be stable across restarts** — it is the catalog primary key and the lookup
key for group mapping.

**The backend accepts no inbound connections.** The bridge dials out only. Do not add an
inbound listener to the backend to solve a problem; that is the system's security boundary.

**Adding an adapter touches three places**: `adapters/<name>/adapter.conf`, a read-only volume
mount in `backend/docker-compose.yml`, and a matching `--config` flag in the same service's
`command:` list. Missing the third is silent.

## Read path and caching

`/api/catalog` carries **both** the sensor catalog and 24h history (`?hours=N`) in one
response — they are non-user-specific and wanted at the same instant, so they ride one
request. There is no `/api/history`; `chart.js` does not fetch for itself, it exposes
`window.renderTrends(series)` which `app.js` calls from its single 60s refresh loop.

`readings.fields` is a JSON blob, not one column per metric, so a new sensor field needs no
migration. `bridgeIngest` copies every numeric field except `HISTORY_SKIP` (radio/protocol
noise). A series object therefore contains **only the metrics that sensor actually reports** —
never assume a key exists. `chart.js` skips any metric with no points, which is what stops a
sensor rendering a permanently-empty chart for a field it doesn't send.

`/api/catalog` is cached in `caches.default` under a synthetic host-independent key and
purged on bridge ingest. **The cache lookup runs after `identify()` but before `upsertUser`**
— read the security invariant above `catalogCacheKey` in `src/index.ts` before touching it.
That pattern is safe only for responses identical across all authorized users; do not extend
it to `/api/custom`, `/api/config`, or `/api/me`.
