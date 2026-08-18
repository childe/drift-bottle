import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import app from "../src/index";

async function seed(publicId: string, status: string, lat: number, lon: number) {
  const t = "2026-08-01T00:00:00Z";
  const beachedAt = status === "beached" ? "2026-08-05T00:00:00Z" : null;
  await env.DB.prepare(
    `INSERT INTO bottles (public_id, status, lat, lon, beached_at, launched_at, simulated_to, distance_km, created_at, lang)
     VALUES (?, ?, ?, ?, ?, ?, '2026-08-05', 42, ?, 'en')`
  ).bind(publicId, status, lat, lon, beachedAt, t, t).run();
  const row = await env.DB.prepare("SELECT id FROM bottles WHERE public_id = ?").bind(publicId).first();
  return row!.id as number;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM track_points").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare("DELETE FROM tokens").run();
  await env.DB.prepare("DELETE FROM bottles").run();
});

describe("/api/bottles/view 视野内瓶子", () => {
  it("返回视野内的漂流+搁浅瓶（带 status），排除界外", async () => {
    await seed("drift0000001", "drifting", 10, 10);
    await seed("beach0000001", "beached", 11, 12);
    await seed("outside00001", "drifting", 40, 40); // 界外

    const res = await app.request("/api/bottles/view?s=0&n=20&w=0&e=20", {}, env);
    expect(res.status).toBe(200);
    const { bottles, truncated } = await res.json();
    const ids = bottles.map((b: { public_id: string }) => b.public_id).sort();
    expect(ids).toEqual(["beach0000001", "drift0000001"]);
    const beach = bottles.find((b: { public_id: string }) => b.public_id === "beach0000001");
    expect(beach.status).toBe("beached");
    expect(typeof beach.days_at_sea).toBe("number");
    expect(truncated).toBe(false);
  });

  it("非法 bounds → 400", async () => {
    expect((await app.request("/api/bottles/view?s=20&n=0&w=0&e=20", {}, env)).status).toBe(400); // s>n
    expect((await app.request("/api/bottles/view?s=0&n=x&w=0&e=20", {}, env)).status).toBe(400); // 非数字
  });
});

describe("/api/bottles/:publicId/trajectory 轨迹（不含内容）", () => {
  it("返回轨迹点与统计，绝不含信件内容", async () => {
    const id = await seed("traj00000001", "drifting", 5, 5);
    await env.DB.prepare(
      `INSERT INTO track_points (bottle_id, ts, lat, lon)
       VALUES (?, '2026-08-01T00:00:00Z', 5, 5), (?, '2026-08-02T00:00:00Z', 5.5, 5.5)`
    ).bind(id, id).run();
    await env.DB.prepare(
      `INSERT INTO messages (bottle_id, content, lat, lon, created_at)
       VALUES (?, '秘密内容不可泄露', 5, 5, '2026-08-01T00:00:00Z')`
    ).bind(id).run();

    const res = await app.request("/api/bottles/traj00000001/trajectory", {}, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.track).toHaveLength(2);
    expect(data.status).toBe("drifting");
    expect(data.distance_km).toBe(42);
    // 绝不含信件内容
    expect(data.messages).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("秘密内容不可泄露");
  });

  it("未知 public_id → 404", async () => {
    expect((await app.request("/api/bottles/doesnotexist1/trajectory", {}, env)).status).toBe(404);
  });
});
