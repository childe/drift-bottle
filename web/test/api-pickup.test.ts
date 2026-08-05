import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import app from "../src/index";
import { OceanMask, setMask, GridSpec } from "../src/ocean";

const grid: GridSpec = { lat0: 30, lon0: 120, dLat: 0.1, dLon: 0.1, nLat: 20, nLon: 20 };
function syntheticMask() {
  const bits = new Uint8Array((20 * 20) / 8);
  for (let iy = 0; iy < 20; iy++)
    for (let ix = 10; ix < 20; ix++) {
      const idx = iy * 20 + ix;
      bits[idx >> 3] |= 1 << (7 - (idx & 7));
    }
  return new OceanMask(bits, grid);
}
const testEnv = () => ({ ...env, AI: { run: async () => ({ response: "safe" }) } }) as typeof env;
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, testEnv());

// 造一只搁浅瓶：搁浅点 (31.0, 121.05)（陆地边缘），附近海域在 lon>=121
async function makeBeachedBottle(publicId = "beachedpub01") {
  const t = "2026-08-01T00:00:00Z";
  await env.DB.prepare(
    `INSERT INTO bottles (public_id, status, lat, lon, beached_at, launched_at, simulated_to, distance_km, created_at)
     VALUES (?, 'beached', 31.0, 121.05, '2026-08-03T06:00:00Z', ?, '2026-08-03', 88.5, ?)`
  ).bind(publicId, t, t).run();
  await env.DB.prepare(
    `INSERT INTO messages (bottle_id, content, lat, lon, created_at)
     SELECT id, '第一封信', 31.0, 121.5, ? FROM bottles WHERE public_id = ?`
  ).bind(t, publicId).run();
}

beforeEach(async () => {
  setMask(syntheticMask());
  await env.DB.prepare("DELETE FROM track_points").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare("DELETE FROM tokens").run();
  await env.DB.prepare("DELETE FROM bottles").run();
});

describe("nearby / read / pickup", () => {
  it("30km 内可见，60km 外不可见", async () => {
    await makeBeachedBottle();
    const near = await app.request("/api/nearby?lat=31.1&lon=121.1", {}, testEnv());
    const { bottles } = await near.json();
    expect(bottles).toHaveLength(1);
    expect(bottles[0].public_id).toBe("beachedpub01");
    expect(bottles[0].distance_km).toBe(88.5);

    const far = await app.request("/api/nearby?lat=31.6&lon=121.1", {}, testEnv());
    expect((await far.json()).bottles).toHaveLength(0);
  });
  it("读信：近处可读，远处 403", async () => {
    await makeBeachedBottle();
    const ok = await post("/api/bottles/beachedpub01/read", { lat: 31.05, lon: 121.1 });
    expect(ok.status).toBe(200);
    expect((await ok.json()).messages[0].content).toBe("第一封信");

    const far = await post("/api/bottles/beachedpub01/read", { lat: 32.5, lon: 121.1 });
    expect(far.status).toBe(403);
  });
  it("捡瓶：回复后重新入海，发新 token；瓶子回到 drifting", async () => {
    await makeBeachedBottle();
    const res = await post("/api/bottles/beachedpub01/pickup", {
      content: "捡到啦，送你回大海", lat: 31.05, lon: 121.1,
    });
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect(token).toMatch(/^[A-Za-z0-9]{21}$/);

    const track = await app.request(`/api/track/${token}`, {}, testEnv());
    const data = await track.json();
    expect(data.status).toBe("drifting");
    expect(data.beached_at).toBeNull();
    expect(data.messages).toHaveLength(2);
    expect(data.position.lon).toBeGreaterThanOrEqual(121.0); // 吸附回海
  });
  it("两人抢同一瓶：后者 409", async () => {
    await makeBeachedBottle();
    const first = await post("/api/bottles/beachedpub01/pickup", { content: "我先", lat: 31.05, lon: 121.1 });
    expect(first.status).toBe(200);
    const second = await post("/api/bottles/beachedpub01/pickup", { content: "我后", lat: 31.05, lon: 121.1 });
    expect(second.status).toBe(409);
  });
  it("漂流中的瓶子读/捡返回 409 已被捡走", async () => {
    await makeBeachedBottle();
    await env.DB.prepare(`UPDATE bottles SET status='drifting' WHERE public_id='beachedpub01'`).run();
    expect((await post("/api/bottles/beachedpub01/read", { lat: 31.05, lon: 121.1 })).status).toBe(409);
    expect((await post("/api/bottles/beachedpub01/pickup", { content: "x", lat: 31.05, lon: 121.1 })).status).toBe(409);
  });
});
