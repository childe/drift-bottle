import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import app from "../src/index";

// 在赤道 (0,0) 附近布点，便于距离估算（1° ≈ 111.32km）
async function seedBeached(publicId: string, lat: number, lon: number) {
  const t = "2026-08-01T00:00:00Z";
  await env.DB.prepare(
    `INSERT INTO bottles (public_id, status, lat, lon, beached_at, launched_at, simulated_to, distance_km, created_at, lang)
     VALUES (?, 'beached', ?, ?, '2026-08-05T00:00:00Z', ?, '2026-08-05', 50, ?, 'en')`
  ).bind(publicId, lat, lon, t, t).run();
}
async function seedDrifting(publicId: string, lat: number, lon: number, distanceKm: number) {
  const t = "2026-08-01T00:00:00Z";
  await env.DB.prepare(
    `INSERT INTO bottles (public_id, status, lat, lon, launched_at, simulated_to, distance_km, created_at, lang)
     VALUES (?, 'drifting', ?, ?, ?, '2026-08-05', ?, ?, 'en')`
  ).bind(publicId, lat, lon, t, distanceKm, t).run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM track_points").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare("DELETE FROM tokens").run();
  await env.DB.prepare("DELETE FROM bottles").run();
});

describe("/api/nearby 漂流中瓶子（只看不可捡）", () => {
  it("返回搁浅瓶(bottles，带 public_id) 与漂流瓶(drifting，无 public_id)，各按半径过滤", async () => {
    await seedBeached("beach1111111", 0.1, 0.1); // ~15.7km，30km 内
    await seedDrifting("driftnear001", 0.1, 0.0, 11); // ~11km，视野内
    await seedDrifting("driftfar0001", 1.0, 0.0, 111); // ~111km，>30km 但 <200km，视野内
    await seedDrifting("driftgone001", 2.0, 0.0, 222); // ~222km，>200km，视野外

    const res = await app.request("/api/nearby?lat=0&lon=0", {}, env);
    expect(res.status).toBe(200);
    const { bottles, drifting } = await res.json();

    // 搁浅瓶：仅 30km 内、可捡、带 public_id
    expect(bottles).toHaveLength(1);
    expect(bottles[0].public_id).toBe("beach1111111");

    // 漂流瓶：200km 视野内的 2 只，排除 222km 外的那只
    expect(drifting).toHaveLength(2);
    for (const d of drifting) {
      expect(d.public_id).toBeUndefined(); // 不暴露 public_id（无交互、无追踪把手）
      expect(typeof d.lat).toBe("number");
      expect(typeof d.lon).toBe("number");
      expect(typeof d.distance_km).toBe("number");
      expect(typeof d.days_at_sea).toBe("number");
      expect(d.days_at_sea).toBeGreaterThanOrEqual(0);
    }
    const dists = drifting.map((d: { distance_km: number }) => d.distance_km).sort((a: number, b: number) => a - b);
    expect(dists).toEqual([11, 111]);
  });

  it("搁浅瓶不进 drifting，漂流瓶不进 bottles", async () => {
    await seedBeached("beach2222222", 0.05, 0.0); // ~5.5km
    await seedDrifting("drift2222222", 0.05, 0.05, 7); // ~7.8km

    const res = await app.request("/api/nearby?lat=0&lon=0", {}, env);
    const { bottles, drifting } = await res.json();
    expect(bottles.map((b: { public_id: string }) => b.public_id)).toEqual(["beach2222222"]);
    expect(drifting).toHaveLength(1);
    expect(drifting[0].public_id).toBeUndefined();
    expect(drifting[0].distance_km).toBe(7);
  });
});
