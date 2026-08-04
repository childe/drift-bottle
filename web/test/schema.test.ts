import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("schema", () => {
  it("可以插入并查询 bottle", async () => {
    await env.DB.prepare(
      `INSERT INTO bottles (public_id, lat, lon, launched_at, simulated_to, created_at)
       VALUES ('testpub00001', 30.5, 123.5, '2026-08-04T00:00:00Z', '2026-08-04', '2026-08-04T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT * FROM bottles WHERE public_id='testpub00001'`).first();
    expect(row!.status).toBe("drifting");
    expect(row!.distance_km).toBe(0);
  });
});
