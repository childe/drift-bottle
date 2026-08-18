import { Hono } from "hono";
import type { Context } from "hono";
import { newToken, newPublicId } from "./ids";
import { haversineKm, bboxAround } from "./geo";
import { getMask } from "./ocean";
import { moderate } from "./moderation";
import { ogMetaTags, injectHead } from "./og";

export type Env = { DB: D1Database; AI: Ai; ASSETS: Fetcher; OG: R2Bucket };

const app = new Hono<{ Bindings: Env }>();
const PICKUP_RADIUS_KM = 30;
const MAX_VIEW_BOTTLES = 500;

type C = Context<{ Bindings: Env }>;
const err = (c: C, status: 400 | 403 | 404 | 409 | 422 | 503, code: string, message: string) =>
  c.json({ error: { code, message } }, status);
const now = () => new Date().toISOString();

function validCoords(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === "number" && typeof lon === "number" &&
    isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon as number) <= 180
  );
}
function validContent(content: unknown): content is string {
  return typeof content === "string" && content.trim().length > 0 && content.length <= 500;
}

/** 审核 + 通过校验的公共前置。返回 Response 表示已出错。 */
async function checkSubmission(c: C, content: unknown, lat: unknown, lon: unknown) {
  if (!validContent(content)) return err(c, 400, "bad_content", "Content must be 1-500 characters");
  if (!validCoords(lat, lon)) return err(c, 400, "bad_coords", "Invalid coordinates");
  const mod = await moderate(c.env.AI, content as string);
  if (mod === "unavailable") return err(c, 503, "moderation_unavailable", "Moderation service unavailable, please try again later");
  if (mod === "unsafe") return err(c, 422, "rejected", "Content did not pass moderation");
  return null;
}

app.post("/api/bottles", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { content, lat, lon } = body as Record<string, unknown>;
  const lang = (body as Record<string, unknown>).lang === "zh" ? "zh" : "en";
  const bad = await checkSubmission(c, content, lat, lon);
  if (bad) return bad;
  const mask = await getMask(c.env);
  const snap = mask.snapToOcean(lat as number, lon as number);
  if (!snap) return err(c, 400, "no_ocean", "No launchable ocean found");
  const t = now();
  const day = t.slice(0, 10);
  const token = newToken();
  const publicId = newPublicId();
  // 单事务写入：batch 全成或全败，靠唯一 public_id 关联刚插入的 bottle 行，杜绝孤儿行
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO bottles (public_id, status, lat, lon, launched_at, simulated_to, distance_km, created_at, lang)
       VALUES (?, 'drifting', ?, ?, ?, ?, 0, ?, ?)`
    ).bind(publicId, snap.lat, snap.lon, t, day, t, lang),
    c.env.DB.prepare(
      `INSERT INTO tokens (token, bottle_id, role, created_at)
       SELECT ?, id, 'dropper', ? FROM bottles WHERE public_id = ?`
    ).bind(token, t, publicId),
    c.env.DB.prepare(
      `INSERT INTO messages (bottle_id, content, lat, lon, created_at)
       SELECT id, ?, ?, ?, ? FROM bottles WHERE public_id = ?`
    ).bind((content as string).trim(), snap.lat, snap.lon, t, publicId),
    c.env.DB.prepare(
      `INSERT INTO track_points (bottle_id, ts, lat, lon)
       SELECT id, ?, ?, ? FROM bottles WHERE public_id = ?`
    ).bind(t, snap.lat, snap.lon, publicId),
  ]);
  return c.json({ token, position: { lat: snap.lat, lon: snap.lon }, snapped_km: Math.round(snap.snappedKm * 10) / 10 });
});

app.get("/api/track/:token", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT b.* FROM tokens t JOIN bottles b ON b.id = t.bottle_id WHERE t.token = ?`
  ).bind(c.req.param("token")).first();
  if (!row) return err(c, 404, "not_found", "Bottle not found");
  const msgs = await c.env.DB.prepare(
    `SELECT content, lat, lon, created_at FROM messages WHERE bottle_id = ? ORDER BY id`
  ).bind(row.id).all();
  const pts = await c.env.DB.prepare(
    `SELECT ts, lat, lon FROM track_points WHERE bottle_id = ? ORDER BY ts`
  ).bind(row.id).all();
  return c.json({
    status: row.status,
    position: { lat: row.lat, lon: row.lon },
    beached_at: row.beached_at,
    distance_km: row.distance_km,
    created_at: row.created_at,
    messages: msgs.results,
    track: pts.results,
  });
});

app.get("/api/nearby", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lon = Number(c.req.query("lon"));
  if (!validCoords(lat, lon)) return err(c, 400, "bad_coords", "Invalid coordinates");
  const box = bboxAround(lat, lon, PICKUP_RADIUS_KM);
  const rows = await c.env.DB.prepare(
    `SELECT public_id, lat, lon, beached_at, distance_km, created_at
     FROM bottles WHERE status = 'beached' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`
  ).bind(box.latMin, box.latMax, box.lonMin, box.lonMax).all();
  const bottles = rows.results
    .filter((b) => haversineKm(lat, lon, b.lat as number, b.lon as number) <= PICKUP_RADIUS_KM)
    .map((b) => ({
      public_id: b.public_id,
      lat: b.lat,
      lon: b.lon,
      beached_at: b.beached_at,
      distance_km: b.distance_km,
      days_at_sea: Math.max(0, Math.round(
        (Date.parse(b.beached_at as string) - Date.parse(b.created_at as string)) / 86400e3)),
    }));
  return c.json({ bottles });
});

// 视野内的瓶子（拖动地图浏览整片海）：漂流+搁浅都返回，仅用于展示/画轨迹，不含内容
app.get("/api/bottles/view", async (c) => {
  const n = Number(c.req.query("n"));
  const s = Number(c.req.query("s"));
  const e = Number(c.req.query("e"));
  const w = Number(c.req.query("w"));
  if (![n, s, e, w].every((v) => Number.isFinite(v)) || s > n)
    return err(c, 400, "bad_bounds", "Invalid bounds");
  // 经度可能跨反经线（w>e）：普通区间用 BETWEEN，跨越时用 OR
  const lonClause = w <= e ? "lon BETWEEN ? AND ?" : "(lon >= ? OR lon <= ?)";
  const rows = await c.env.DB.prepare(
    `SELECT public_id, status, lat, lon, distance_km, created_at
     FROM bottles WHERE lat BETWEEN ? AND ? AND ${lonClause} LIMIT ?`
  ).bind(s, n, w, e, MAX_VIEW_BOTTLES + 1).all();
  const nowMs = Date.now();
  const bottles = rows.results.slice(0, MAX_VIEW_BOTTLES).map((b) => ({
    public_id: b.public_id,
    status: b.status,
    lat: b.lat,
    lon: b.lon,
    distance_km: b.distance_km,
    days_at_sea: Math.max(0, Math.floor((nowMs - Date.parse(b.created_at as string)) / 86400e3)),
  }));
  return c.json({ bottles, truncated: rows.results.length > MAX_VIEW_BOTTLES });
});

// 瓶子轨迹（公开，按 public_id）：只给轨迹点与漂流统计，绝不含信件内容
app.get("/api/bottles/:publicId/trajectory", async (c) => {
  const b = await c.env.DB.prepare(
    `SELECT id, status, distance_km, launched_at, created_at FROM bottles WHERE public_id = ?`
  ).bind(c.req.param("publicId")).first();
  if (!b) return err(c, 404, "not_found", "Bottle not found");
  const track = await c.env.DB.prepare(
    `SELECT lat, lon, ts FROM track_points WHERE bottle_id = ? ORDER BY ts ASC`
  ).bind(b.id).all();
  return c.json({
    status: b.status,
    distance_km: b.distance_km,
    launched_at: b.launched_at,
    created_at: b.created_at,
    track: track.results.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts })),
  });
});

/** 找到搁浅瓶并做距离校验；返回 Response 表示已出错。 */
async function findBeachedNearby(c: C, publicId: string, lat: unknown, lon: unknown) {
  if (!validCoords(lat, lon)) return err(c, 400, "bad_coords", "Invalid coordinates");
  const b = await c.env.DB.prepare(
    `SELECT id, status, lat, lon FROM bottles WHERE public_id = ?`
  ).bind(publicId).first();
  if (!b) return err(c, 404, "not_found", "No such bottle here");
  // public_id 只经由 nearby（仅列出 beached 瓶）泄露，非 beached 必然是刚被捡走重新入海
  if (b.status !== "beached") return err(c, 409, "already_picked", "This bottle was just picked up by someone else");
  if (haversineKm(lat as number, lon as number, b.lat as number, b.lon as number) > PICKUP_RADIUS_KM)
    return err(c, 403, "too_far", "You are too far from this bottle");
  return b as { id: number; lat: number; lon: number };
}

app.post("/api/bottles/:publicId/read", async (c) => {
  const { lat, lon } = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const b = await findBeachedNearby(c, c.req.param("publicId"), lat, lon);
  if (b instanceof Response) return b;
  const msgs = await c.env.DB.prepare(
    `SELECT content, lat, lon, created_at FROM messages WHERE bottle_id = ? ORDER BY id`
  ).bind(b.id).all();
  return c.json({ messages: msgs.results });
});

app.post("/api/bottles/:publicId/pickup", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { content, lat, lon } = body;
  const b = await findBeachedNearby(c, c.req.param("publicId"), lat, lon);
  if (b instanceof Response) return b;
  const bad = await checkSubmission(c, content, lat, lon);
  if (bad) return bad;
  const mask = await getMask(c.env);
  const snap = mask.snapToOcean(b.lat, b.lon); // 从搁浅点回海
  if (!snap) return err(c, 400, "no_ocean", "No ocean found nearby");
  const t = now();
  const day = t.slice(0, 10);
  const token = newToken();
  const results = await c.env.DB.batch([
    // 第1条：原子抢占。token 唯一，条件插入：仅 status='beached' 时成功，取代 UPDATE 成为抢占哨兵
    c.env.DB.prepare(
      `INSERT INTO tokens (token, bottle_id, role, created_at)
       SELECT ?, id, 'picker', ? FROM bottles WHERE id = ? AND status = 'beached'`
    ).bind(token, t, b.id),
    // 第2-4条：gate 在"我的 token 已存在"——输家 token 未插入，EXISTS 为假，全部 no-op
    c.env.DB.prepare(
      `UPDATE bottles SET status='drifting', lat=?, lon=?, beached_at=NULL, launched_at=?, simulated_to=?
       WHERE id = ? AND EXISTS (SELECT 1 FROM tokens WHERE token = ?)`
    ).bind(snap.lat, snap.lon, t, day, b.id, token),
    c.env.DB.prepare(
      `INSERT INTO messages (bottle_id, content, lat, lon, created_at)
       SELECT id, ?, ?, ?, ? FROM bottles WHERE id = ? AND EXISTS (SELECT 1 FROM tokens WHERE token = ?)`
    ).bind((content as string).trim(), snap.lat, snap.lon, t, b.id, token),
    c.env.DB.prepare(
      `INSERT INTO track_points (bottle_id, ts, lat, lon)
       SELECT id, ?, ?, ? FROM bottles WHERE id = ? AND EXISTS (SELECT 1 FROM tokens WHERE token = ?)`
    ).bind(t, snap.lat, snap.lon, b.id, token),
  ]);
  // batch 是单事务；抢占判定看第1条 changes：token 唯一，输家 INSERT 不满足 status='beached' → changes=0
  // 分工：findBeachedNearby 前置检查管顺序滞后请求，token 条件插入管真·同瞬并发竞争
  if ((results[0].meta.changes ?? 0) === 0)
    return err(c, 409, "already_picked", "This bottle was just picked up by someone else");
  return c.json({ token });
});

// 追踪页：/b/<token> 动态注入 per-bottle OG 预览卡 meta；查不到/异常回代纯页面（fail-open）
app.get("/b/*", async (c) => {
  const plain = () => c.env.ASSETS.fetch(new Request(new URL("/track.html", c.req.url)));
  const token = c.req.path.replace(/^\/b\//, "").split("/")[0];
  if (!token) return plain();
  let row: Record<string, unknown> | null = null;
  try {
    row = await c.env.DB.prepare(
      `SELECT b.public_id AS publicId, b.status, b.distance_km AS distanceKm,
              b.created_at AS createdAt, b.lang AS lang
       FROM tokens t JOIN bottles b ON b.id = t.bottle_id WHERE t.token = ?`
    ).bind(token).first();
  } catch {
    row = null;
  }
  if (!row) return plain();
  const html = await (await plain()).text();
  const origin = new URL(c.req.url).origin;
  const days = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(String(row.createdAt))) / 86400000)
  );
  const dayStamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const tags = ogMetaTags({
    origin,
    publicId: String(row.publicId),
    lang: row.lang === "zh" ? "zh" : "en",
    days,
    distanceKm: Number(row.distanceKm) || 0,
    status: String(row.status),
    canonicalUrl: `${origin}/b/${token}`,
    dayStamp,
  });
  return c.html(injectHead(html, tags));
});

// OG 图：从 R2 读 og/{public_id}.png，缺失/异常回退默认卡（fail-open）
app.get("/og/:file", async (c) => {
  const fallback = () => c.env.ASSETS.fetch(new Request(new URL("/og-default.png", c.req.url)));
  const m = c.req.param("file").match(/^([A-Za-z0-9]{12})\.png$/);
  if (!m) return fallback();
  let obj: R2ObjectBody | null = null;
  try {
    obj = await c.env.OG.get(`og/${m[1]}.png`);
  } catch {
    obj = null;
  }
  if (!obj) return fallback();
  return new Response(obj.body, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" },
  });
});

export default app;
