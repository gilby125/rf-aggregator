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
  const admins = env.ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const isAdmin = admins.includes(who.email.toLowerCase()) ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO users (email, sub, is_admin, created_at) VALUES (?1, ?2, ?3, unixepoch())
     ON CONFLICT(email) DO UPDATE SET sub = ?2, is_admin = max(is_admin, ?3)`
  ).bind(who.email, who.sub, isAdmin).run();
  return env.DB.prepare(`SELECT id, email, is_admin FROM users WHERE email = ?1`)
    .bind(who.email)
    .first<{ id: number; email: string; is_admin: number }>();
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

// ---------- Path B + user/config/admin endpoints (Access-gated) ----------

type Sensor = { sensor_id: string; last_seen: number; latest: string };

async function computeCustom(env: Env, sensorIds: string[], periodS: number) {
  if (!sensorIds.length) return { computed: {}, stale_ids: [] as string[] };
  const ph = sensorIds.map((_, i) => `?${i + 1}`).join(",");
  const rows = await env.DB.prepare(
    `SELECT sensor_id, last_seen, latest FROM catalog WHERE sensor_id IN (${ph})`
  ).bind(...sensorIds).all<Sensor>();
  const now = Math.floor(Date.now() / 1000);
  const staleBefore = now - 2 * periodS;
  const sums: Record<string, { sum: number; n: number }> = {};
  const staleIds: string[] = [];
  const seen = new Set<string>();
  for (const row of rows.results) {
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

async function currentPeriodS(env: Env): Promise<number> {
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

  if (path === "/api/catalog") {
    const rows = await env.DB.prepare(
      `SELECT sensor_id, source, type, last_seen FROM catalog ORDER BY sensor_id`
    ).all();
    return json({ v: V, sensors: rows.results });
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
      const periodS = await currentPeriodS(env);
      const groups = [];
      for (const r of rows.results) {
        const ids = JSON.parse(r.sensor_ids) as string[];
        groups.push({ name: r.name, sensor_ids: ids, ...(await computeCustom(env, ids, periodS)) });
      }
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
      const user = await upsertUser(env, who);
      if (!user) return err(500, "user provisioning failed");
      return handleUserApi(request, env, path, user);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
