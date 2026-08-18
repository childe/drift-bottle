import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import app from "../src/index";

const FAKE_HTML = `<!doctype html><html><head><title>t</title></head><body>x</body></html>`;
const testEnv = () =>
  ({
    ...env,
    ASSETS: { fetch: async () => new Response(FAKE_HTML, { headers: { "content-type": "text/html" } }) },
  }) as typeof env;

async function seed(pid: string, token: string, lang: string) {
  await env.DB.prepare(
    `INSERT INTO bottles (public_id, status, lat, lon, launched_at, simulated_to, distance_km, created_at, lang)
     VALUES (?, 'drifting', 0, 0, '2026-07-01T00:00:00Z', '2026-07-01', 3200, '2026-07-01T00:00:00Z', ?)`
  ).bind(pid, lang).run();
  const row = await env.DB.prepare("SELECT id FROM bottles WHERE public_id = ?").bind(pid).first();
  await env.DB.prepare(
    `INSERT INTO tokens (token, bottle_id, role, created_at) VALUES (?, ?, 'dropper', '2026-07-01T00:00:00Z')`
  ).bind(token, row!.id).run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM tokens").run();
  await env.DB.prepare("DELETE FROM bottles").run();
});

describe("/b/{token} 动态 OG 注入", () => {
  it("命中 token → 注入带 public_id 的 og:image 与本地化 og:title", async () => {
    await seed("pubid1111111", "tok".padEnd(21, "A"), "zh");
    const res = await app.request(`/b/${"tok".padEnd(21, "A")}`, {}, testEnv());
    const html = await res.text();
    expect(html).toContain("/og/pubid1111111.png");
    expect(html).toContain("漂流瓶");
    expect(html).toContain('name="twitter:card"');
  });
  it("未知 token → 回代纯页面，无注入", async () => {
    const res = await app.request(`/b/${"zzz".padEnd(21, "Z")}`, {}, testEnv());
    const html = await res.text();
    expect(html).not.toContain("/og/");
    expect(html).toContain("<title>t</title>");
  });
});
