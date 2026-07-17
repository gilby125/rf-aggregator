# rf-aggregator

Open-source platform that **consumes decoded RF event feeds**, groups/aggregates them, retains
and gateways the results, and serves them to multiple users through a Cloudflare edge front
(self-serve OTP sign-up, per-user config). The operator self-hosts the private backend on any
container host; Cloudflare fronts everything user-facing — the free tier is enough.

Hardware-agnostic and format-flexible: it starts at the **decoded feed** (bring your own decoder
— rtl_433 today; rtlamr, dump1090, rtl_ais planned) and does **not** manage SDRs, dongles,
drivers, or frequencies.

## Architecture

```
                        BACKEND (self-hosted, private)                     EDGE (Cloudflare, public)
  decoder ─MQTT→ ┌───────────────────────────────────────────┐        ┌──────────────────────────────┐
  (rtl_433,      │ adapter → aggregator (Telegraf)            │        │ Worker (API + UI, same-origin)│
   out of scope) │   • id→group lookup  • per-group mean      │        │   • Access OTP-gated          │
                 │        │                          │        │        │   • Path A: /aggregates.json  │
                 │        ├─→ InfluxDB (retain raw + agg)      │        │   • Path B: on-demand compute │
                 │        └─→ MQTT gateway (rf/events, rf/agg) │        │ D1 (users, config, catalog,   │
                 │                                             │        │     group_defs, custom_defs)  │
                 │ bridge (Go, OUTBOUND ONLY) ────push up──────┼──HTTPS→│ /api/bridge/ingest            │
                 │                            ◀───pull defs────┼────────┤ /api/bridge/defs              │
                 └───────────────────────────────────────────┘        └──────────────┬───────────────┘
                                                                                      │ Access (OTP)
                                                                            users (browser) ◀┘
```

**Backend** (any container host): an **adapter** normalizes the decoder's native MQTT/JSON into a
schema-light event envelope; **Telegraf** tags each sensor with a `group` (id→group lookup) and
computes a per-group mean each `AGG_PERIOD`; results are retained in **InfluxDB** (raw +
aggregates) and re-published to an **MQTT gateway** (`rf/events/<id>`, `rf/agg/<group>`). A small
**Go bridge** is the only thing that talks to the cloud — outbound only, service-token auth: it
pushes the sensor catalog + latest values + shared aggregates **up**, pulls group definitions
**down**, and renders the Telegraf lookup file (a version-stamped rewrite triggers a config
reload).

**Edge** (Cloudflare): one **Worker** serves both the API and the UI (static assets, same-origin
to avoid Access CORS issues), gated by **Cloudflare Access** with self-serve one-time-PIN signup.
**D1** holds users, per-user config, the sensor catalog, and group definitions.

**Two read paths:**
- **Path A — shared:** admin-defined groups are aggregated once on the backend and served from an
  edge-cached `/aggregates.json`. Identical for everyone → reads are ~free at realistic scale.
- **Path B — custom:** each user defines their own sensor groups; the Worker computes their
  current averages on demand from the latest values in D1.

The three cross-boundary interfaces (event envelope, backend↔edge API, config schemas) are
documented and versioned in [docs/CONTRACTS.md](docs/CONTRACTS.md), so backend, edge, and
adapters are independently swappable.

## Repo layout

| Path | What |
|---|---|
| `adapters/rtl433/` | rtl_433 → envelope adapter (Telegraf config, no code) |
| `backend/` | docker compose: Telegraf pipeline + InfluxDB + Go bridge; `compose.komodo.yml` prod override |
| `backend/bridge/` | the Go bridge agent |
| `edge/worker/` | Cloudflare Worker (`src/index.ts`), UI (`public/`), D1 migrations |
| `docs/PLAN.md` | architecture rationale, decisions, risks |
| `docs/CONTRACTS.md` | the versioned interfaces (envelope, API, config) |
| `docs/DEPLOY.md` | full deploy walkthrough + local dev |

## Install

### Quickstart — backend only, no hardware

Runs the whole backend against a **synthetic** rtl_433 feed (bundled broker + generator):

```sh
cd backend
cp .env.example .env          # defaults are fine for a local run
docker compose --profile dev up -d --build
docker compose exec mosquitto mosquitto_sub -v -t 'rf/agg/#'   # watch per-group aggregates
```

### Backend against a real feed

Point it at your decoder's broker and drop the dev profile:

```sh
cd backend && cp .env.example .env
#   FEED_MQTT_URL=tcp://<your-broker>:1883
#   FEED_TOPIC=rtl_433/+/events     # rtl_433 publishes to rtl_433/<id>/events
docker compose up -d --build
```

Run rtl_433 (out of scope for this repo) with an MQTT events sink, e.g.
`rtl_433 -F mqtt://<broker>:1883,events`. Until you define groups, everything lands in
`unassigned` — that's expected; groups are defined from the edge UI.

### Edge (Cloudflare, free tier)

```sh
cd edge/worker && npm install
npx wrangler login
npx wrangler d1 create rf_aggregator            # put the id in wrangler.toml
npx wrangler d1 migrations apply rf_aggregator --remote
npx wrangler secret put BRIDGE_TOKEN            # must match backend/.env BRIDGE_TOKEN
npx wrangler deploy
```

Then set up **Cloudflare Access** (OTP self-serve signup, plus Bypass rules for `/api/bridge/*`
and `/aggregates.json`) and fill `TEAM_DOMAIN` / `POLICY_AUD` / `ADMIN_EMAILS` in `wrangler.toml`.
Finally set `EDGE_URL` + `BRIDGE_TOKEN` in `backend/.env` so the bridge syncs up. Full
step-by-step (including the exact Access policy) is in [docs/DEPLOY.md](docs/DEPLOY.md).

Local edge dev: `cp .dev.vars.example .dev.vars` (sets `DEV_MODE=1` to stub Access),
`npm run db:migrate:local`, `npx wrangler dev --ip 0.0.0.0`.

## Usage (web UI)

Open the Worker URL; Cloudflare Access emails you a one-time PIN to sign in (no admin approval).
The page auto-refreshes every 60s. Sections, top to bottom:

- **Groups** — the shared, admin-defined groups (Path A), each showing its per-group averages.
- **My custom groups** — your own groups (Path B), computed on demand; **edit** reopens a group
  to change its members, **✕** deletes. Each card lists its member sensors.
- **Sensors** — every device's latest reading with a wall-clock + elapsed timestamp; radio fields
  (`freq`, `rssi`, `snr`, …) shown here, battery-low flagged.
- **Ungrouped sensors** — devices not in any group yet (a to-do list; this is what the backend's
  `unassigned` bucket means).
- **Admin** (admins only) — a JSON editor for the shared group definitions:
  `{"backyard": ["Acurite-5n1-156-B", …]}`. Saving bumps `defs_version`; the backend re-maps
  within one bridge sync. **log out** is in the header (note: it's a team-wide Access logout).

**How grouping works:** each sensor maps to exactly one shared group; a group's average is
computed per-field across only the sensors that report that field (a rain gauge in a temp group
won't distort the temperature mean). Averaging is meaningful mainly for many like-kind sensors;
for a handful of distinct home sensors the per-sensor view, history, and MQTT gateway are the
value.

Nothing is hardcoded — backend scalars live in `backend/.env` (`AGG_PERIOD`, `SYNC_PERIOD`,
topics, broker, `EDGE_URL`, `BRIDGE_TOKEN`), edge config in `wrangler.toml`.

## Status

v1 implemented and running in production (backend on a container host, edge on Cloudflare):
adapter → aggregator → InfluxDB + MQTT gateway, outbound bridge sync, Access-gated Worker + UI,
both read paths, per-sensor view, live group-defs propagation. License: **MIT**.
