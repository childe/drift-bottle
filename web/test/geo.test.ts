import { describe, it, expect } from "vitest";
import { haversineKm, bboxAround } from "../src/geo";

describe("geo", () => {
  it("上海→杭州约 165km", () => {
    const d = haversineKm(31.23, 121.47, 30.25, 120.17);
    expect(d).toBeGreaterThan(150);
    expect(d).toBeLessThan(180);
  });
  it("同点距离为 0", () => {
    expect(haversineKm(30, 120, 30, 120)).toBe(0);
  });
  it("边界框包含半径内的点", () => {
    const box = bboxAround(31.0, 122.0, 30);
    expect(box.latMin).toBeLessThan(30.9);
    expect(box.latMax).toBeGreaterThan(31.1);
    expect(box.lonMin).toBeLessThan(121.8);
    expect(box.lonMax).toBeGreaterThan(122.2);
  });
});
