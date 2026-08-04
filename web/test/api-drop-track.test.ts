import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import app from "../src/index";
import { OceanMask, setMask, GridSpec } from "../src/ocean";

// 20x20、0.1°、原点 (30N,120E)：ix<10 陆地，ix>=10 海洋
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

let aiResponse: string | Error = "safe";
const testEnv = () =>
  ({ ...env, AI: { run: async () => {
    if (aiResponse instanceof Error) throw aiResponse;
    return { response: aiResponse };
  } } }) as typeof env;

const drop = (body: unknown) =>
  app.request("/api/bottles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, testEnv());

beforeEach(async () => {
  setMask(syntheticMask());
  aiResponse = "safe";
  await env.DB.prepare("DELETE FROM track_points").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare("DELETE FROM tokens").run();
  await env.DB.prepare("DELETE FROM bottles").run();
});

describe("投瓶→追踪闭环", () => {
  it("投瓶成功返回 token，凭 token 可追踪", async () => {
    const res = await drop({ content: "你好，大海", lat: 30.55, lon: 120.05 }); // 陆地点，应吸附
    expect(res.status).toBe(200);
    const { token, position, snapped_km } = await res.json();
    expect(token).toMatch(/^[A-Za-z0-9]{21}$/);
    expect(position.lon).toBeGreaterThanOrEqual(121.0); // 吸附进海域
    expect(snapped_km).toBeGreaterThan(0);

    const track = await app.request(`/api/track/${token}`, {}, testEnv());
    expect(track.status).toBe(200);
    const data = await track.json();
    expect(data.status).toBe("drifting");
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].content).toBe("你好，大海");
    expect(data.track).toHaveLength(1);
  });
  it("未知 token → 404", async () => {
    const res = await app.request("/api/track/aaaaaaaaaaaaaaaaaaaaa", {}, testEnv());
    expect(res.status).toBe(404);
  });
  it("审核 unsafe → 422 且不入库", async () => {
    aiResponse = "unsafe\nS1";
    const res = await drop({ content: "bad content", lat: 30.5, lon: 121.5 });
    expect(res.status).toBe(422);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM bottles").first();
    expect(n!.n).toBe(0);
  });
  it("审核不可用 → 503（fail-closed）", async () => {
    aiResponse = new Error("ai down");
    const res = await drop({ content: "hi", lat: 30.5, lon: 121.5 });
    expect(res.status).toBe(503);
  });
  it("超长/空内容与非法坐标 → 400", async () => {
    expect((await drop({ content: "x".repeat(501), lat: 30.5, lon: 121.5 })).status).toBe(400);
    expect((await drop({ content: "  ", lat: 30.5, lon: 121.5 })).status).toBe(400);
    expect((await drop({ content: "hi", lat: 91, lon: 0 })).status).toBe(400);
  });
});
