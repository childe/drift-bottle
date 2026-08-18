import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import app from "../src/index";
import { OceanMask, setMask, GridSpec } from "../src/ocean";

// 20x20、0.1°、原点 (30N,120E)：ix>=10 为海洋（与 api-drop-track 同款合成掩码）
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
const testEnv = () =>
  ({ ...env, AI: { run: async () => ({ response: "safe" }) } }) as typeof env;
const drop = (body: unknown) =>
  app.request("/api/bottles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, testEnv());

beforeEach(async () => {
  setMask(syntheticMask());
  await env.DB.prepare("DELETE FROM track_points").run();
  await env.DB.prepare("DELETE FROM messages").run();
  await env.DB.prepare("DELETE FROM tokens").run();
  await env.DB.prepare("DELETE FROM bottles").run();
});

describe("投瓶记录语言", () => {
  it("lang=zh 写入 zh", async () => {
    const res = await drop({ content: "hi", lat: 30.5, lon: 121.5, lang: "zh" });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT lang FROM bottles").first();
    expect(row!.lang).toBe("zh");
  });
  it("lang=en 写入 en", async () => {
    await drop({ content: "hi", lat: 30.5, lon: 121.5, lang: "en" });
    expect((await env.DB.prepare("SELECT lang FROM bottles").first())!.lang).toBe("en");
  });
  it("缺失 lang 回退 en", async () => {
    await drop({ content: "hi", lat: 30.5, lon: 121.5 });
    expect((await env.DB.prepare("SELECT lang FROM bottles").first())!.lang).toBe("en");
  });
  it("非法 lang 回退 en", async () => {
    await drop({ content: "hi", lat: 30.5, lon: 121.5, lang: "fr" });
    expect((await env.DB.prepare("SELECT lang FROM bottles").first())!.lang).toBe("en");
  });
});
