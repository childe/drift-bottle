import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import app from "../src/index";
import { OceanMask, setMask, GridSpec } from "../src/ocean";

// 全海洋掩码，覆盖 (0,0) 与 (10,10)，便于测远距离回信 + pickup 重投吸附
const grid: GridSpec = { lat0: -20, lon0: -20, dLat: 1, dLon: 1, nLat: 40, nLon: 40 };
function oceanMask() {
  const bits = new Uint8Array(Math.ceil((40 * 40) / 8)).fill(0xff);
  return new OceanMask(bits, grid);
}
const testEnv = () => ({ ...env, AI: { run: async () => ({ response: "safe" }) } }) as typeof env;
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, testEnv());

async function seedBeached(pid: string, open: boolean) {
  const t = "2026-08-01T00:00:00Z";
  await env.DB.prepare(
    `INSERT INTO bottles (public_id, status, lat, lon, beached_at, launched_at, simulated_to, distance_km, created_at, lang, open_reply)
     VALUES (?, 'beached', 0, 0, '2026-08-05T00:00:00Z', ?, '2026-08-05', 10, ?, 'en', ?)`
  ).bind(pid, t, t, open ? 1 : 0).run();
  await env.DB.prepare(
    `INSERT INTO messages (bottle_id, content, lat, lon, created_at) SELECT id, '第一封', 0, 0, ? FROM bottles WHERE public_id = ?`
  ).bind(t, pid).run();
}

beforeEach(async () => {
  setMask(oceanMask());
  await env.DB.prepare("DELETE FROM track_points").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare("DELETE FROM tokens").run();
  await env.DB.prepare("DELETE FROM bottles").run();
});

describe("open_reply 允许任何地方的人回复", () => {
  it("投瓶 open_reply=true 存 1", async () => {
    const res = await post("/api/bottles", { content: "hi", lat: 0, lon: 0, open_reply: true });
    expect(res.status).toBe(200);
    expect((await env.DB.prepare("SELECT open_reply FROM bottles").first())!.open_reply).toBe(1);
  });

  it("投瓶默认 open_reply=0", async () => {
    await post("/api/bottles", { content: "hi", lat: 0, lon: 0 });
    expect((await env.DB.prepare("SELECT open_reply FROM bottles").first())!.open_reply).toBe(0);
  });

  it("open 瓶：~1568km 外也能读 + 回信重投", async () => {
    await seedBeached("openpub00001", true);
    const read = await post("/api/bottles/openpub00001/read", { lat: 10, lon: 10 });
    expect(read.status).toBe(200);
    expect((await read.json()).messages[0].content).toBe("第一封");
    const pick = await post("/api/bottles/openpub00001/pickup", { content: "远方的回信", lat: 10, lon: 10 });
    expect(pick.status).toBe(200);
    expect((await pick.json()).token).toMatch(/^[A-Za-z0-9]{21}$/);
  });

  it("普通瓶：远处读/回 → 403（不变）", async () => {
    await seedBeached("normalpub001", false);
    expect((await post("/api/bottles/normalpub001/read", { lat: 10, lon: 10 })).status).toBe(403);
    expect((await post("/api/bottles/normalpub001/pickup", { content: "x", lat: 10, lon: 10 })).status).toBe(403);
  });

  it("普通瓶：30km 内仍可读", async () => {
    await seedBeached("normalpub002", false);
    expect((await post("/api/bottles/normalpub002/read", { lat: 0.1, lon: 0.1 })).status).toBe(200);
  });

  it("/api/bottles/view 返回 open_reply 标记", async () => {
    await seedBeached("viewopen0001", true);
    await seedBeached("viewnorm0001", false);
    const res = await app.request("/api/bottles/view?s=-5&n=5&w=-5&e=5", {}, testEnv());
    const { bottles } = await res.json();
    expect(bottles.find((b: { public_id: string }) => b.public_id === "viewopen0001").open_reply).toBe(true);
    expect(bottles.find((b: { public_id: string }) => b.public_id === "viewnorm0001").open_reply).toBe(false);
  });
});
