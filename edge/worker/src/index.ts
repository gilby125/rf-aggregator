// rf-aggregator edge Worker: API + UI (static assets) in one same-origin deployment.
// Contracts: docs/CONTRACTS.md. Auth: Cloudflare Access JWT for users, bearer for the bridge.
import { jwtVerify, createRemoteJWKSet } from "jose";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  ADMIN_EMAILS: string;
  DEV_MODE: string;
  BRIDGE_TOKEN?: string;
}

const V = 1;

// Radio/protocol fields carry no trend value and would bloat every history row. Mirrors
// GROUP_HIDE in public/app.js (kept in sync by hand — they serve different layers).
const HISTORY_SKIP = new Set([
  "freq", "rssi", "snr", "noise", "protocol", "message_type",
  "sequence_num", "sendmode", "button", "mic", "subtype", "status", "battery_ok",
]);

type Identity = { email: string; sub: string };

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const err = (status: number, message: string) => json({ v: V, error: message }, status);

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function identify(request: Request, env: Env): Promise<Identity | null> {
  if (env.DEV_MODE === "1") {
    return { email: request.headers.get("x-dev-email") ?? "dev@example.com", sub: "dev" };
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  jwks ??= createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
    });
    if (typeof payload.email !== "string") return null;
    return { email: payload.email, sub: String(payload.sub ?? "") };
  } catch {
    return null;
  }
}

async function upsertUser(env: Env, who: Identity) {
  const admins = (env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const isAdmin = admins.includes(who.email.toLowerCase()) ? 1 : 0;
  // RETURNING makes this one query instead of INSERT-then-SELECT. The DO UPDATE always
  // executes on conflict, so a row comes back even when nothing actually changed.
  return env.DB.prepare(
    `INSERT INTO users (email, sub, is_admin, created_at) VALUES (?1, ?2, ?3, unixepoch())
     ON CONFLICT(email) DO UPDATE SET sub = ?2, is_admin = max(is_admin, ?3)
     RETURNING id, email, is_admin`
  ).bind(who.email, who.sub, isAdmin).first<{ id: number; email: string; is_admin: number }>();
}

async function kvGet(env: Env, k: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT v FROM kv WHERE k = ?1`).bind(k).first<{ v: string }>();
  return row?.v ?? null;
}

const kvPut = (env: Env, k: string, v: string) =>
  env.DB.prepare(`INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2`)
    .bind(k, v)
    .run();

// ---------- bridge endpoints (bearer auth) ----------

function bridgeAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get("authorization") ?? "";
  return !!env.BRIDGE_TOKEN && auth === `Bearer ${env.BRIDGE_TOKEN}`;
}

async function bridgeIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json()) as {
    v: number;
    catalog?: { id: string; source: string; type: string; last_seen: number; latest: Record<string, number> }[];
    aggregates?: { period_s: number; groups: Record<string, { ts: number; fields: Record<string, number> }> };
  };
  if (body.v !== V) return err(400, `unsupported contract version ${body.v}`);

  const stmts = (body.catalog ?? []).map((c) =>
    env.DB.prepare(
      `INSERT INTO catalog (sensor_id, source, type, last_seen, latest) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(sensor_id) DO UPDATE SET source = ?2, type = ?3, last_seen = ?4, latest = ?5`
    ).bind(c.id, c.source, c.type, c.last_seen, JSON.stringify(c.latest ?? {}))
  );
  if (stmts.length) await env.DB.batch(stmts);

  // Time-series history for the 24h charts. The bridge re-sends the same snapshot
  // every sync; UNIQUE(sensor_id, ts) + INSERT OR IGNORE dedupes to one row per
  // actual sensor reading (keyed on last_seen). Prune beyond 48h to stay bounded.
  const nowS = Math.floor(Date.now() / 1000);
  const reads = [];
  for (const c of body.catalog ?? []) {
    // Generic over field names: whatever numeric readings the sensor sent, minus radio noise.
    const fields: Record<string, number> = {};
    for (const [k, v] of Object.entries(c.latest ?? {})) {
      if (typeof v === "number" && !HISTORY_SKIP.has(k)) fields[k] = v;
    }
    if (!Object.keys(fields).length) continue;
    reads.push(
      env.DB.prepare(`INSERT OR IGNORE INTO readings (sensor_id, ts, fields) VALUES (?1, ?2, ?3)`)
        .bind(c.id, c.last_seen || nowS, JSON.stringify(fields))
    );
  }
  if (reads.length) {
    // Prune is a full index scan; at SYNC_PERIOD=15s, running it every ingest is 5760
    // scans/day. The window must be <= one sync interval or it fires several times an hour.
    if (nowS % 3600 < 15) {
      reads.push(env.DB.prepare(`DELETE FROM readings WHERE ts < ?1`).bind(nowS - 48 * 3600));
    }
    await env.DB.batch(reads);
  }

  if (body.aggregates) {
    const doc = {
      v: V,
      updated: Math.floor(Date.now() / 1000),
      period_s: body.aggregates.period_s,
      groups: body.aggregates.groups,
    };
    await kvPut(env, "aggregates_json", JSON.stringify(doc));
    // Best-effort freshness: purge this colo's cached copy so Path A picks up the new
    // window within a sync instead of a full s-maxage. Other colos age out naturally.
    ctx.waitUntil(caches.default.delete(new Request(AGG_CACHE_KEY)));
  }
  // Same idea for catalog+history — but only when this ingest actually advanced something.
  // The bridge re-sends an unchanged snapshot every SYNC_PERIOD (15s in dev), so purging
  // unconditionally evicted the entry faster than it could ever serve. Compare the incoming
  // high-water mark against the one stamped on the cached copy: a cache.match + header read,
  // no D1. Keyed by `hours`, so only the windows the UI asks for.
  const maxSeen = Math.max(0, ...(body.catalog ?? []).map((c) => c.last_seen ?? 0));
  ctx.waitUntil(
    Promise.all(CACHED_WINDOWS.map(async (h) => {
      const key = catalogCacheKey(h);
      const cached = await caches.default.match(key);
      if (!cached) return;
      if (maxSeen > Number(cached.headers.get(MAX_SEEN_HEADER) ?? 0)) await caches.default.delete(key);
    }))
  );
  const defsVersion = parseInt((await kvGet(env, "defs_version")) ?? "0", 10);
  return json({ v: V, ok: true, defs_version: defsVersion });
}

async function bridgeDefs(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT group_name, sensor_ids FROM group_defs`).all<{
    group_name: string;
    sensor_ids: string;
  }>();
  const group_defs: Record<string, string[]> = {};
  for (const r of rows.results) group_defs[r.group_name] = JSON.parse(r.sensor_ids);
  const defsVersion = parseInt((await kvGet(env, "defs_version")) ?? "0", 10);
  return json({ v: V, defs_version: defsVersion, group_defs });
}

// ---------- Path A: shared aggregates, edge-cached ----------

// Host-independent cache key: users and the bridge may reach the Worker via different
// hostnames (workers.dev, custom domain, dev), and the ingest purge must hit the same entry.
const AGG_CACHE_KEY = "https://rf-aggregator.internal/aggregates.json";

async function aggregates(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(AGG_CACHE_KEY);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const doc = (await kvGet(env, "aggregates_json")) ?? JSON.stringify({ v: V, updated: 0, period_s: 300, groups: {} });
  const periodS = (JSON.parse(doc) as { period_s?: number }).period_s ?? 300;
  const resp = json(JSON.parse(doc), 200, {
    "cache-control": `public, s-maxage=${periodS}, max-age=${periodS}`,
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

// ---------- catalog + history (Access-gated, but identical for every user) ----------

// Catalog and history are both non-user-specific and both wanted at the same instant, so
// they ride one request. This replaced a separate /api/history endpoint that the trend
// charts polled on their own timer, doubling invocations for data in the same payload.
//
// SECURITY INVARIANT — read this before touching the caching below:
//   1. The cache lookup happens strictly AFTER identify() returns a verified Access JWT.
//      An unauthenticated request 401s before ever reaching it, so the cache memoizes the
//      PAYLOAD, never the authorization decision.
//   2. The payload is byte-identical for every authorized user — no user id, email, or
//      per-user config. If a per-user field is ever added here, this cache leaks it
//      between users and must be removed.
// Neither condition holds for /api/custom, /api/config or /api/me. Do NOT extend this to them.
const catalogCacheKey = (hours: number) =>
  new Request(`https://rf-aggregator.internal/catalog-${hours}.json`);

// Two copies of one body. The shared-cache copy must be `public` — the Cache API refuses to
// store a `private` response — while the browser copy must be `private` so no intermediary
// caches an Access-gated payload. 50s sits just under the client's 60s poll so the browser
// entry is reliably still fresh when the next tick fires (that is what removes the
// invocation entirely; an edge hit still runs the Worker).
const BROWSER_CC = "private, max-age=50";
const EDGE_CC = "public, s-maxage=60";

// Highest last_seen in the cached payload. bridgeIngest compares against it so an unchanged
// re-push doesn't evict a still-accurate entry. Internal, stripped before the browser sees it.
const MAX_SEEN_HEADER = "x-max-seen";
// The `hours` windows worth purging. Others age out on s-maxage; the UI only asks for 24.
const CACHED_WINDOWS = [24, 48];

const catalogHours = (request: Request) =>
  Math.min(168, Math.max(1, parseInt(new URL(request.url).searchParams.get("hours") || "24", 10) || 24));

async function catalogAndHistory(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const hours = catalogHours(request);
  const key = catalogCacheKey(hours);
  const hit = await caches.default.match(key);
  if (hit) {
    // Rewrite the shared-cache directive to the browser one on the way out, and drop the
    // internal high-water stamp.
    const h = new Headers(hit.headers);
    h.set("cache-control", BROWSER_CC);
    h.delete(MAX_SEEN_HEADER);
    return new Response(hit.body, { status: hit.status, headers: h });
  }

  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const [cat, hist] = await env.DB.batch<Record<string, string | number>>([
    env.DB.prepare(`SELECT sensor_id, source, type, last_seen, latest FROM catalog ORDER BY sensor_id`),
    env.DB.prepare(`SELECT sensor_id, ts, fields FROM readings WHERE ts >= ?1 ORDER BY ts`).bind(since),
  ]);
  const sensors = (cat.results as unknown as {
    sensor_id: string; source: string; type: string; last_seen: number; latest: string;
  }[]).map((r) => ({
    sensor_id: r.sensor_id,
    source: r.source,
    type: r.type,
    last_seen: r.last_seen,
    latest: JSON.parse(r.latest ?? "{}"),
  }));

  // series[sensor][metric] = [[ts, value], …] — keys are only the metrics that sensor
  // actually reports, so the client must not assume any particular one exists.
  const series: Record<string, Record<string, [number, number][]>> = {};
  for (const r of hist.results as unknown as { sensor_id: string; ts: number; fields: string }[]) {
    const s = (series[r.sensor_id] ??= {});
    for (const [k, v] of Object.entries(JSON.parse(r.fields ?? "{}"))) {
      if (typeof v === "number") (s[k] ??= []).push([r.ts, v]);
    }
  }

  const body = JSON.stringify({ v: V, sensors, history: { hours, series } });
  const maxSeen = Math.max(0, ...sensors.map((s) => s.last_seen ?? 0));
  ctx.waitUntil(
    caches.default.put(key, new Response(body, {
      headers: {
        "content-type": "application/json",
        "cache-control": EDGE_CC,
        [MAX_SEEN_HEADER]: String(maxSeen),
      },
    }))
  );
  return new Response(body, {
    headers: { "content-type": "application/json", "cache-control": BROWSER_CC },
  });
}

// ---------- Path B + user/config/admin endpoints (Access-gated) ----------

type Sensor = { sensor_id: string; last_seen: number; latest: string };

// Pure: takes rows already fetched. The caller loads every group's sensors in ONE query,
// so N groups cost 1 catalog read instead of N sequential ones.
function computeCustom(rows: Sensor[], sensorIds: string[], periodS: number) {
  if (!sensorIds.length) return { computed: {}, stale_ids: [] as string[] };
  const now = Math.floor(Date.now() / 1000);
  const staleBefore = now - 2 * periodS;
  const sums: Record<string, { sum: number; n: number }> = {};
  const staleIds: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.sensor_id);
    if ((row.last_seen ?? 0) < staleBefore) {
      staleIds.push(row.sensor_id);
      continue;
    }
    const fields = JSON.parse(row.latest) as Record<string, number>;
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== "number") continue;
      (sums[k] ??= { sum: 0, n: 0 }).sum += v;
      sums[k]!.n += 1;
    }
  }
  for (const id of sensorIds) if (!seen.has(id)) staleIds.push(id);
  const computed: Record<string, number> = {};
  for (const [k, { sum, n }] of Object.entries(sums)) computed[k] = sum / n;
  return { computed, stale_ids: staleIds };
}

// period_s lives in the same doc /aggregates.json serves, and that one is edge-cached — read
// it from the cache first so the common path costs no D1 query at all.
async function currentPeriodS(env: Env): Promise<number> {
  const hit = await caches.default.match(new Request(AGG_CACHE_KEY));
  if (hit) {
    try {
      return ((await hit.json()) as { period_s?: number }).period_s ?? 300;
    } catch { /* fall through to D1 */ }
  }
  const doc = await kvGet(env, "aggregates_json");
  return doc ? ((JSON.parse(doc) as { period_s?: number }).period_s ?? 300) : 300;
}

async function handleUserApi(
  request: Request,
  env: Env,
  path: string,
  user: { id: number; email: string; is_admin: number }
): Promise<Response> {
  const method = request.method;

  if (path === "/api/me") {
    return json({ v: V, email: user.email, is_admin: !!user.is_admin });
  }

  if (path === "/api/config") {
    if (method === "GET") {
      const row = await env.DB.prepare(`SELECT config FROM user_config WHERE user_id = ?1`)
        .bind(user.id)
        .first<{ config: string }>();
      return json({ v: V, config: JSON.parse(row?.config ?? "{}") });
    }
    if (method === "PUT") {
      const cfg = await request.json();
      await env.DB.prepare(
        `INSERT INTO user_config (user_id, config) VALUES (?1, ?2)
         ON CONFLICT(user_id) DO UPDATE SET config = ?2`
      ).bind(user.id, JSON.stringify(cfg)).run();
      return json({ v: V, ok: true });
    }
  }

  if (path === "/api/custom") {
    if (method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT name, sensor_ids FROM custom_defs WHERE user_id = ?1 ORDER BY name`
      ).bind(user.id).all<{ name: string; sensor_ids: string }>();
      // Most users have no custom groups; don't pay for period_s or a catalog read.
      if (!rows.results.length) return json({ v: V, groups: [] });

      const defs = rows.results.map((r) => ({
        name: r.name,
        ids: JSON.parse(r.sensor_ids) as string[],
      }));
      // One catalog read covering the union of every group's members, rather than one query
      // per group in a sequential await loop.
      const union = [...new Set(defs.flatMap((d) => d.ids))];
      const ph = union.map((_, i) => `?${i + 1}`).join(",");
      const [periodS, catRows] = await Promise.all([
        currentPeriodS(env),
        env.DB.prepare(`SELECT sensor_id, last_seen, latest FROM catalog WHERE sensor_id IN (${ph})`)
          .bind(...union).all<Sensor>(),
      ]);
      const byId = new Map(catRows.results.map((r) => [r.sensor_id, r]));

      const groups = defs.map((d) => ({
        name: d.name,
        sensor_ids: d.ids,
        ...computeCustom(d.ids.map((id) => byId.get(id)).filter((r): r is Sensor => !!r), d.ids, periodS),
      }));
      return json({ v: V, groups });
    }
    if (method === "POST") {
      const body = (await request.json()) as { name?: string; sensor_ids?: string[] };
      const name = (body.name ?? "").trim();
      if (!name || !Array.isArray(body.sensor_ids) || !body.sensor_ids.length) {
        return err(400, "name and non-empty sensor_ids required");
      }
      await env.DB.prepare(
        `INSERT INTO custom_defs (user_id, name, sensor_ids, updated_at) VALUES (?1, ?2, ?3, unixepoch())
         ON CONFLICT(user_id, name) DO UPDATE SET sensor_ids = ?3, updated_at = unixepoch()`
      ).bind(user.id, name, JSON.stringify(body.sensor_ids)).run();
      return json({ v: V, ok: true });
    }
    if (method === "DELETE") {
      const name = new URL(request.url).searchParams.get("name") ?? "";
      await env.DB.prepare(`DELETE FROM custom_defs WHERE user_id = ?1 AND name = ?2`)
        .bind(user.id, name)
        .run();
      return json({ v: V, ok: true });
    }
  }

  if (path === "/api/admin/group_defs") {
    if (!user.is_admin) return err(403, "admin only");
    if (method === "GET") {
      return bridgeDefs(env); // same shape the bridge pulls
    }
    if (method === "PUT") {
      const body = (await request.json()) as { group_defs?: Record<string, string[]> };
      if (!body.group_defs || typeof body.group_defs !== "object") {
        return err(400, "group_defs object required");
      }
      const stmts = [env.DB.prepare(`DELETE FROM group_defs`)];
      for (const [g, ids] of Object.entries(body.group_defs)) {
        if (!Array.isArray(ids)) return err(400, `sensor_ids for ${g} must be an array`);
        stmts.push(
          env.DB.prepare(
            `INSERT INTO group_defs (group_name, sensor_ids, updated_at) VALUES (?1, ?2, unixepoch())`
          ).bind(g, JSON.stringify(ids))
        );
      }
      await env.DB.batch(stmts);
      const next = parseInt((await kvGet(env, "defs_version")) ?? "0", 10) + 1;
      await kvPut(env, "defs_version", String(next));
      return json({ v: V, ok: true, defs_version: next });
    }
  }

  return err(404, "not found");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/aggregates.json") return aggregates(request, env, ctx);

    if (path.startsWith("/api/bridge/")) {
      if (!bridgeAuthorized(request, env)) return err(401, "bad bridge token");
      if (path === "/api/bridge/ingest" && request.method === "POST") return bridgeIngest(request, env, ctx);
      if (path === "/api/bridge/defs" && request.method === "GET") return bridgeDefs(env);
      return err(404, "not found");
    }

    if (path.startsWith("/api/")) {
      const who = await identify(request, env);
      if (!who) return err(401, "no valid Access token");

      // Served before upsertUser on purpose: that call costs a D1 write on EVERY request,
      // so running it first would make a cache hit cost a query anyway. Provisioning still
      // happens — /api/me runs at page load. See the invariant above catalogCacheKey.
      if (path === "/api/catalog" && request.method === "GET") {
        return catalogAndHistory(request, env, ctx);
      }

      const user = await upsertUser(env, who);
      if (!user) return err(500, "user provisioning failed");
      return handleUserApi(request, env, path, user);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
