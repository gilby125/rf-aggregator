# rf-aggregator

Open-source platform that **consumes decoded RF event feeds**, aggregates/groups them, retains
and gateways the results, and serves them to multiple users through a Cloudflare edge front
(self-serve sign-up, auth, per-user config). The operator self-hosts the private backend on any
container host; Cloudflare fronts everything user-facing — free tier is enough.

Hardware-agnostic and format-flexible — it starts at the **decoded feed** (bring your own
decoder: rtl_433 today; rtlamr, dump1090, rtl_ais planned) and does not manage SDRs, dongles,
drivers, or frequencies.

```
decoder ─MQTT→ [adapter → aggregator (Telegraf) → InfluxDB + MQTT gateway] ─bridge (outbound only)→
                [Cloudflare: Worker API + UI + D1 + Access OTP signup] → users
```

- **Path A (shared)**: admin-defined groups, aggregated once on the backend, served to everyone
  from an edge-cached `aggregates.json` — reads are ~free at any realistic scale.
- **Path B (custom)**: each user can define their own sensor groups; the Worker computes their
  current averages on demand from latest values in D1.

## Layout

| Path | What |
|---|---|
| `adapters/rtl433/` | rtl_433 → envelope adapter (config-only) |
| `backend/` | docker compose: Telegraf pipeline, InfluxDB, Go bridge agent |
| `edge/worker/` | Cloudflare Worker (API + UI static assets), D1 migrations |
| `docs/PLAN.md` | architecture, decisions, risks |
| `docs/CONTRACTS.md` | the versioned interfaces: event envelope, backend↔edge API, config |
| `docs/DEPLOY.md` | step-by-step deploy (backend, Cloudflare, Access) + local dev |

## Quickstart (no hardware needed)

```sh
cd backend && cp .env.example .env
docker compose --profile dev up -d --build     # synthetic rtl_433 feed included
docker compose exec mosquitto mosquitto_sub -v -t 'rf/agg/#'
```

See [docs/DEPLOY.md](docs/DEPLOY.md) for the full setup including the Cloudflare edge.

## Status

v1 implemented and verified end-to-end locally (backend pipeline, bridge sync, edge API/UI,
both read paths, live group-defs propagation). License: MIT.
