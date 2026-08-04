import { Hono } from "hono";
import type { Context } from "hono";
import { newToken, newPublicId } from "./ids";
import { haversineKm, bboxAround } from "./geo";
import { getMask } from "./ocean";
import { moderate } from "./moderation";

export type Env = { DB: D1Database; AI: Ai; ASSETS: Fetcher };

const app = new Hono<{ Bindings: Env }>();
const PICKUP_RADIUS_KM = 30;

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
  if (!validContent(content)) return err(c, 400, "bad_content", "内容不能为空且不超过500字");
  if (!validCoords(lat, lon)) return err(c, 400, "bad_coords", "坐标不合法");
  const mod = await moderate(c.env.AI, content as string);
  if (mod === "unavailable") return err(c, 503, "moderation_unavailable", "审核服务暂不可用，请稍后再试");
  if (mod === "unsafe") return err(c, 422, "rejected", "内容未通过审核");
  return null;
}

app.post("/api/bottles", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { content, lat, lon } = body as Record<string, unknown>;
  const bad = await checkSubmission(c, content, lat, lon);
  if (bad) return bad;
  const mask = await getMask(c.env);
  const snap = mask.snapToOcean(lat as number, lon as number);
  if (!snap) return err(c, 400, "no_ocean", "找不到可投放的海域");
  const t = now();
  const day = t.slice(0, 10);
  const token = newToken();
  const publicId = newPublicId();
  // 单事务写入：batch 全成或全败，靠唯一 public_id 关联刚插入的 bottle 行，杜绝孤儿行
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO bottles (public_id, status, lat, lon, launched_at, simulated_to, distance_km, created_at)
       VALUES (?, 'drifting', ?, ?, ?, ?, 0, ?)`
    ).bind(publicId, snap.lat, snap.lon, t, day, t),
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
  if (!row) return err(c, 404, "not_found", "瓶子不存在");
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

// 追踪页：/b/<token> 由前端 track.html 渲染
app.get("/b/*", (c) => c.env.ASSETS.fetch(new Request(new URL("/track.html", c.req.url))));

export default app;
