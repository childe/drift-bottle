import { describe, it, expect } from "vitest";
import { OceanMask, GridSpec } from "../src/ocean";

// 8x8 网格，1°分辨率，lat0=0, lon0=0；左半（ix<4）陆地，右半海洋
const grid: GridSpec = { lat0: 0, lon0: 0, dLat: 1, dLon: 1, nLat: 8, nLon: 8 };
function buildMask(): OceanMask {
  const bits = new Uint8Array((8 * 8) / 8);
  for (let iy = 0; iy < 8; iy++)
    for (let ix = 4; ix < 8; ix++) {
      const idx = iy * 8 + ix;
      bits[idx >> 3] |= 1 << (7 - (idx & 7));
    }
  return new OceanMask(bits, grid);
}

describe("OceanMask", () => {
  it("位读取正确", () => {
    const m = buildMask();
    expect(m.isSafeCell(3, 2)).toBe(false); // 陆地
    expect(m.isSafeCell(3, 5)).toBe(true); // 海洋
  });
  it("海上点原地返回（snappedKm=0）", () => {
    const m = buildMask();
    const s = m.snapToOcean(3.5, 6.5)!; // 落在安全海格内
    expect(s.snappedKm).toBe(0);
    expect(s.lat).toBe(3.5);
    expect(s.lon).toBe(6.5);
  });
  it("陆地点吸附到最近海格", () => {
    const m = buildMask();
    const s = m.snapToOcean(3.5, 2.5)!; // 陆地，最近海格在 ix=4 列
    expect(s.lon).toBeGreaterThanOrEqual(4);
    expect(s.lon).toBeLessThan(5.1);
    expect(s.snappedKm).toBeGreaterThan(100); // 约1.5°经度+0.5°纬度
  });
  it("全陆掩码返回 null", () => {
    const empty = new OceanMask(new Uint8Array(8), grid);
    expect(empty.snapToOcean(3, 3)).toBeNull();
  });
});
