import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../src/index";

const HIT = "aaaaaaaaaaaa";
const testEnv = () =>
  ({
    ...env,
    OG: {
      get: async (key: string) =>
        key === `og/${HIT}.png` ? { body: new Response("PNGDATA").body } : null,
    },
    ASSETS: {
      fetch: async () => new Response("DEFAULT", { headers: { "content-type": "image/png" } }),
    },
  }) as unknown as typeof env;

describe("/og/{pid}.png", () => {
  it("命中 → 返回 R2 PNG + 缓存头", async () => {
    const res = await app.request(`/og/${HIT}.png`, {}, testEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age");
    expect(await res.text()).toBe("PNGDATA");
  });
  it("未命中 → 默认卡", async () => {
    const res = await app.request(`/og/bbbbbbbbbbbb.png`, {}, testEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("DEFAULT");
  });
  it("非法 public_id → 默认卡", async () => {
    const res = await app.request(`/og/not-valid.png`, {}, testEnv());
    expect(await res.text()).toBe("DEFAULT");
  });
});
