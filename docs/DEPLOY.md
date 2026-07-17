# Deploying rf-aggregator

Two halves: the **backend** (any container host, private) and the **edge** (Cloudflare, public,
free tier). They meet only at the bridge's outbound HTTPS calls (docs/CONTRACTS.md §2).

## 1. Backend (any container host)

```sh
cd backend
cp .env.example .env        # fill in tokens; point FEED_MQTT_URL at your broker
docker compose up -d --build
# no broker/decoder yet? bundled quickstart broker:   docker compose --profile broker up -d
# no hardware at all? synthetic rtl_433 feed:         docker compose --profile dev up -d
```

Your decoder must publish JSON events to `FEED_TOPIC` on `FEED_MQTT_URL` (for rtl_433:
`-F mqtt://<broker>:1883,events`). Verify:

```sh
docker compose exec mosquitto mosquitto_sub -v -t 'rf/agg/#' -C 2      # per-group aggregates
docker compose exec influxdb influx query 'from(bucket:"rf") |> range(start:-15m) |> group(columns:["_measurement"]) |> distinct(column:"_measurement")' --org rf --token $INFLUX_TOKEN
```

Until group defs exist, everything lands in group `unassigned` — that's expected; groups are
defined at the edge (admin UI) and flow down through the bridge.

Leave `EDGE_URL` empty to run fully standalone (aggregation + retention + MQTT gateway, no
cloud). Set it later and `docker compose up -d` again.

## 2. Edge (Cloudflare free tier)

```sh
cd edge/worker
npm install
npx wrangler login
npx wrangler d1 create rf_aggregator          # put the returned database_id into wrangler.toml
npx wrangler d1 migrations apply rf_aggregator --remote
npx wrangler secret put BRIDGE_TOKEN          # same value as backend/.env
npx wrangler deploy                           # note the https://….workers.dev URL
```

### Cloudflare Access (self-serve OTP signup — verified working on free tier)

1. Zero Trust dashboard → **Settings → Authentication → Login methods → Add: One-time PIN**.
2. **Access → Applications → Add → Self-hosted**, application domain = your workers.dev
   hostname (Access works on `*.workers.dev`; no custom domain needed).
3. Policy: **Action: Allow**, **Include: Everyone** (or `Login Methods: One-time PIN`).
   Any visitor then self-serves: enter email → receive PIN → in. No admin pre-approval.
4. Add **two more path-scoped apps on the same hostname with Action: Bypass**, or the
   non-browser clients break:
   - `<hostname>/api/bridge` → Bypass (the bridge can't do OTP; the Worker enforces
     `BRIDGE_TOKEN` itself)
   - `<hostname>/aggregates.json` → Bypass (Path A is anonymous, cacheable, shared)
5. **Settings → seat expiration**: enable (e.g. 1 month). Free tier = **50 seats**; a seat is
   consumed per authenticated user and user #51 is hard-blocked, so let drive-by seats expire.
6. Copy the Access app's **AUD tag** and your team domain into `wrangler.toml`:
   `TEAM_DOMAIN = "https://<team>.cloudflareaccess.com"`, `POLICY_AUD = "<aud>"`, plus
   `ADMIN_EMAILS = "you@example.com"`. Redeploy: `npx wrangler deploy`.

The Worker independently verifies the `Cf-Access-Jwt-Assertion` JWT against
`<team>.cloudflareaccess.com/cdn-cgi/access/certs` (defense in depth — never trust the header
without verification) and auto-provisions a user row on first visit.

### Connect the backend

In `backend/.env` set `EDGE_URL=https://<worker>.workers.dev` and `BRIDGE_TOKEN`, then
`docker compose up -d`. Within one `SYNC_PERIOD` the catalog appears in the UI; define shared
groups in the admin section and the backend re-maps within a sync (one truncated aggregation
window per defs change — see PLAN.md "Aggregator mapping reload").

## 3. Verification checklist (mirrors PLAN.md)

- [ ] Per-group aggregates on `rf/agg/<group>` update each `AGG_PERIOD` (note: `telegraf
      --test` doesn't exercise service inputs like MQTT — verify against the live pipeline).
- [ ] InfluxDB has `rf_event` (raw) and `rf_event_agg` (aggregates).
- [ ] Bridge lands catalog + aggregates in D1; `/aggregates.json` serves them (Path A).
- [ ] Two users behind Access: both see shared groups; each sees only their own custom
      groups (Path B); non-admin gets 403 on `/api/admin/*`.
- [ ] Admin group_defs edit changes gateway topics/membership within a sync.
- [ ] Unmapped sensors appear as group `unassigned`.

## 4. Scale-out notes (future, from PLAN.md)

- **Path A at large scale**: serving via a Worker + Cache API costs a (cheap) request per read.
  For true request-skipping CDN static, push `aggregates.json` to an R2 public bucket on a
  custom domain and let the CDN cache it.
- **Path B fan-out**: per-user compute is the throughput variable (100k req/day, 10ms CPU
  free). Mitigate with short-TTL per-user caching or Durable Objects push.
- **CORS**: UI and API are same-origin by design (one Worker). If you split them across
  hostnames behind Access, `OPTIONS` preflights get blocked — configure the Access app's CORS
  settings or keep same-origin.

## Local development

```sh
cd edge/worker
cp .dev.vars.example .dev.vars           # DEV_MODE=1 stubs Access (x-dev-email header)
npm run db:migrate:local
npx wrangler dev --ip 0.0.0.0            # 0.0.0.0 so the bridge container can reach it
# backend: EDGE_URL=http://host.docker.internal:8787 in backend/.env, then:
cd ../../backend && docker compose --profile dev up -d --build
```

UI: http://localhost:8787 · stop: `docker compose --profile dev down` (add `-v` to reset data).
