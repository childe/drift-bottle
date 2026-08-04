import { haversineKm } from "./geo";

export interface GridSpec {
  lat0: number;
  lon0: number;
  dLat: number;
  dLon: number;
  nLat: number;
  nLon: number;
}

export const GLO12: GridSpec = {
  lat0: -80,
  lon0: -180,
  dLat: 1 / 12,
  dLon: 1 / 12,
  nLat: 2041,
  nLon: 4320,
};

export class OceanMask {
  constructor(private bits: Uint8Array, readonly grid: GridSpec) {}

  isSafeCell(iy: number, ix: number): boolean {
    const g = this.grid;
    if (iy < 0 || iy >= g.nLat) return false;
    ix = ((ix % g.nLon) + g.nLon) % g.nLon; // 经度环绕
    const idx = iy * g.nLon + ix;
    return ((this.bits[idx >> 3] >> (7 - (idx & 7))) & 1) === 1;
  }

  private cellCenter(iy: number, ix: number): [number, number] {
    const g = this.grid;
    ix = ((ix % g.nLon) + g.nLon) % g.nLon;
    return [g.lat0 + iy * g.dLat, g.lon0 + ix * g.dLon];
  }

  /** 从 (lat,lon) 找最近安全海格：所在格安全则原地返回；否则按切比雪夫环外扩，命中后再看 2 圈取 haversine 最近。 */
  snapToOcean(
    lat: number,
    lon: number
  ): { lat: number; lon: number; snappedKm: number } | null {
    const g = this.grid;
    const iy0 = Math.min(g.nLat - 1, Math.max(0, Math.round((lat - g.lat0) / g.dLat)));
    const ix0 = Math.round((((lon - g.lon0) % 360) + 360) % 360 / g.dLon) % g.nLon;
    if (this.isSafeCell(iy0, ix0)) return { lat, lon, snappedKm: 0 }; // 已在开阔海域，原地投放
    const maxRing = Math.max(g.nLat, g.nLon); // 覆盖全球，实际内陆最远 ~500 环
    let best: { lat: number; lon: number; snappedKm: number } | null = null;
    let foundRing = -1;
    for (let r = 0; r <= maxRing; r++) {
      if (foundRing >= 0 && r > foundRing + 2) break; // 命中后再多看2圈
      for (const [iy, ix] of ringCells(iy0, ix0, r)) {
        if (!this.isSafeCell(iy, ix)) continue;
        const [clat, clon] = this.cellCenter(iy, ix);
        const d = haversineKm(lat, lon, clat, clon);
        if (!best || d < best.snappedKm) best = { lat: clat, lon: clon, snappedKm: d };
        if (foundRing < 0) foundRing = r;
      }
    }
    return best;
  }
}

/** 切比雪夫距离恰为 r 的格子（r=0 时即中心）。 */
function* ringCells(iy0: number, ix0: number, r: number): Generator<[number, number]> {
  if (r === 0) {
    yield [iy0, ix0];
    return;
  }
  for (let dx = -r; dx <= r; dx++) {
    yield [iy0 - r, ix0 + dx];
    yield [iy0 + r, ix0 + dx];
  }
  for (let dy = -r + 1; dy <= r - 1; dy++) {
    yield [iy0 + dy, ix0 - r];
    yield [iy0 + dy, ix0 + r];
  }
}

let cached: OceanMask | null = null;

export function setMask(m: OceanMask | null): void {
  cached = m;
}

export async function getMask(env: { ASSETS: Fetcher }): Promise<OceanMask> {
  if (cached) return cached;
  const res = await env.ASSETS.fetch("https://assets.internal/ocean-mask.bin");
  if (!res.ok) throw new Error(`ocean-mask.bin 加载失败: ${res.status}`);
  cached = new OceanMask(new Uint8Array(await res.arrayBuffer()), GLO12);
  return cached;
}
