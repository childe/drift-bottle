# 漂流瓶 MVP 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 匿名漂流瓶网页应用：投瓶→真实洋流每日漂流→搁浅→附近的人捡起回复再投，全部跑在 Cloudflare + GitHub Actions 免费层。

**Architecture:** Cloudflare Worker（Hono + TS）提供 5 个 API 与静态前端，D1 存储，Workers AI 审核；GitHub Actions 每日拉 CMEMS 全球表层流场，Python/numpy 批量推进瓶子并经 Cloudflare REST API 写回 D1。规格见 `docs/superpowers/specs/2026-08-04-drift-bottle-design.md`。

**Tech Stack:** Hono, TypeScript, wrangler, vitest + @cloudflare/vitest-pool-workers, Leaflet(CDN), Python 3.12 (uv), numpy, xarray, h5netcdf, copernicusmarine, requests, pytest

## Global Constraints

- 信件内容 ≤500 字；捡瓶半径 30km；追踪 token 21 位、public_id 12 位（字母数字，CSPRNG）
- 审核 fail-closed：Workers AI 不可用 → 503 拒绝提交
- 错误响应统一 `{error: {code, message}}`；400 参数错 / 403 距离太远 / 404 不存在 / 409 已被捡走 / 422 审核未通过 / 503 审核不可用
- 面向用户文案全部中文
- Python：uv 管理（`simulation/` 下 `uv sync` / `uv run`）；每次改完 Python 代码用 black 格式化（`/opt/homebrew/bin/black simulation/`）
- 掩码位序约定（TS/Python 必须一致）：`idx = iy*4320 + ix`（iy: 纬度行 0..2040 自南向北, ix: 经度列 0..4319 自西向东），字节 `idx>>3`，位 `7-(idx&7)`（= np.packbits 默认 big 位序）
- GLO12 网格常量：lat0=-80, lon0=-180, dLat=dLon=1/12, nLat=2041, nLon=4320
- 日期/时间一律 UTC，ISO 8601 字符串存储
- git 提交信息末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Web 脚手架 + D1 Schema

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/wrangler.toml`, `web/migrations/0001_init.sql`, `web/vitest.config.ts`, `web/test/apply-migrations.ts`, `web/test/env.d.ts`, `web/test/schema.test.ts`

**Interfaces:**
- Produces: D1 表结构（bottles/tokens/messages/track_points/meta，字段见 SQL）；vitest 环境中 `env.DB` 已应用迁移；后续所有 Worker 任务在此工程内开发

- [ ] **Step 1: 初始化 npm 工程**

```bash
mkdir -p web/src web/public web/migrations web/test
cd web && npm init -y
npm i hono
npm i -D wrangler typescript vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types
```

注：若 peer 依赖冲突，以 `@cloudflare/vitest-pool-workers` 声明的 vitest 版本为准安装对应版本。

- [ ] **Step 2: 写配置文件**

`web/wrangler.toml`：

```toml
name = "drift-bottle"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[assets]
directory = "public"
binding = "ASSETS"
run_worker_first = ["/api/*", "/b/*"]

[[d1_databases]]
binding = "DB"
database_name = "drift-bottle"
database_id = "TBD-AFTER-D1-CREATE"   # Task 13 创建 D1 后回填真实 id

[ai]
binding = "AI"
```

`web/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src", "test"]
}
```

`web/vitest.config.ts`：

```ts
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          miniflare: {
            compatibilityDate: "2026-08-01",
            d1Databases: ["DB"],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
```

`web/test/apply-migrations.ts`：

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`web/test/env.d.ts`：

```ts
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers/config").D1Migration[];
    AI: Ai;
    ASSETS: Fetcher;
  }
}
```

`web/package.json` 增加 scripts：

```json
"scripts": { "test": "vitest run", "dev": "wrangler dev", "deploy": "wrangler deploy" }
```

- [ ] **Step 3: 写 D1 迁移**

`web/migrations/0001_init.sql`：

```sql
CREATE TABLE bottles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id   TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'drifting',
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  beached_at  TEXT,
  launched_at TEXT NOT NULL,
  simulated_to TEXT NOT NULL,
  distance_km REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_bottles_beached ON bottles(status, lat, lon);

CREATE TABLE tokens (
  token      TEXT PRIMARY KEY,
  bottle_id  INTEGER NOT NULL REFERENCES bottles(id),
  role       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tokens_bottle ON tokens(bottle_id);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bottle_id  INTEGER NOT NULL REFERENCES bottles(id),
  content    TEXT NOT NULL,
  lat REAL, lon REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_bottle ON messages(bottle_id);

CREATE TABLE track_points (
  bottle_id  INTEGER NOT NULL,
  ts         TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  PRIMARY KEY (bottle_id, ts)
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

说明：`simulated_to`（已模拟完成的日期 YYYY-MM-DD）是幂等护栏，投瓶时初始化为投放当日 —— 这是对 spec「幂等」要求的实现细化；spec 中的 `meta.sim_watermark` 保留作观测记录。

- [ ] **Step 4: 写 schema 冒烟测试**

`web/test/schema.test.ts`：

```ts
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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd web && npm test`
Expected: schema.test.ts PASS

- [ ] **Step 6: 提交**

```bash
printf 'node_modules/\n.wrangler/\n' >> .gitignore
git add web .gitignore && git commit -m "feat(web): 脚手架与 D1 schema"
```

---

### Task 2: ID 生成与地理工具（ids.ts / geo.ts）

**Files:**
- Create: `web/src/ids.ts`, `web/src/geo.ts`
- Test: `web/test/ids.test.ts`, `web/test/geo.test.ts`

**Interfaces:**
- Produces: `newToken(): string`（21位）、`newPublicId(): string`（12位）、`randomId(n: number): string`；`haversineKm(lat1, lon1, lat2, lon2): number`；`bboxAround(lat, lon, radiusKm): {latMin, latMax, lonMin, lonMax}`

- [ ] **Step 1: 写失败测试**

`web/test/ids.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { newToken, newPublicId, randomId } from "../src/ids";

describe("ids", () => {
  it("长度与字符集正确", () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9]{21}$/);
    expect(newPublicId()).toMatch(/^[A-Za-z0-9]{12}$/);
  });
  it("抽样不重复", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => randomId(21)));
    expect(seen.size).toBe(1000);
  });
});
```

`web/test/geo.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd web && npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`web/src/ids.ts`：

```ts
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const MAX = 256 - (256 % ALPHABET.length); // 拒绝采样去除模偏差

export function randomId(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < MAX && out.length < length) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join("");
}

export const newToken = () => randomId(21);
export const newPublicId = () => randomId(12);
```

`web/src/geo.ts`：

```ts
const R = 6371.0; // km

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bboxAround(lat: number, lon: number, radiusKm: number) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { latMin: lat - dLat, latMax: lat + dLat, lonMin: lon - dLon, lonMax: lon + dLon };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd web && npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/ids.ts web/src/geo.ts web/test/ids.test.ts web/test/geo.test.ts
git commit -m "feat(web): ID 生成与地理工具"
```

---

### Task 3: 海洋掩码与吸附（ocean.ts）

**Files:**
- Create: `web/src/ocean.ts`
- Test: `web/test/ocean.test.ts`

**Interfaces:**
- Produces:
  - `interface GridSpec { lat0: number; lon0: number; dLat: number; dLon: number; nLat: number; nLon: number }`
  - `const GLO12: GridSpec`（全局常量，见 Global Constraints）
  - `class OceanMask { constructor(bits: Uint8Array, grid: GridSpec); isSafeCell(iy: number, ix: number): boolean; snapToOcean(lat: number, lon: number): { lat: number; lon: number; snappedKm: number } | null }`
  - `getMask(env: { ASSETS: Fetcher }): Promise<OceanMask>`（从静态资源 `/ocean-mask.bin` 加载并缓存）
  - `setMask(m: OceanMask | null): void`（测试注入）
- Consumes: `haversineKm`（Task 2）

- [ ] **Step 1: 写失败测试**

`web/test/ocean.test.ts` —— 用 8×8 合成掩码（不依赖真实 bin 文件）：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd web && npm test`
Expected: FAIL（ocean.ts 不存在）

- [ ] **Step 3: 实现**

`web/src/ocean.ts`：

```ts
import { haversineKm } from "./geo";

export interface GridSpec {
  lat0: number; lon0: number; dLat: number; dLon: number; nLat: number; nLon: number;
}

export const GLO12: GridSpec = {
  lat0: -80, lon0: -180, dLat: 1 / 12, dLon: 1 / 12, nLat: 2041, nLon: 4320,
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
  snapToOcean(lat: number, lon: number): { lat: number; lon: number; snappedKm: number } | null {
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
  if (r === 0) { yield [iy0, ix0]; return; }
  for (let dx = -r; dx <= r; dx++) { yield [iy0 - r, ix0 + dx]; yield [iy0 + r, ix0 + dx]; }
  for (let dy = -r + 1; dy <= r - 1; dy++) { yield [iy0 + dy, ix0 - r]; yield [iy0 + dy, ix0 + r]; }
}

let cached: OceanMask | null = null;

export function setMask(m: OceanMask | null): void { cached = m; }

export async function getMask(env: { ASSETS: Fetcher }): Promise<OceanMask> {
  if (cached) return cached;
  const res = await env.ASSETS.fetch("https://assets.internal/ocean-mask.bin");
  if (!res.ok) throw new Error(`ocean-mask.bin 加载失败: ${res.status}`);
  cached = new OceanMask(new Uint8Array(await res.arrayBuffer()), GLO12);
  return cached;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd web && npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/ocean.ts web/test/ocean.test.ts
git commit -m "feat(web): 海洋掩码与最近海格吸附"
```

---

### Task 4: 生成真实海洋掩码（make_mask.py + ocean-mask.bin）

**Files:**
- Create: `simulation/pyproject.toml`, `simulation/make_mask.py`, `simulation/tests/test_make_mask.py`
- Create（生成物）: `web/public/ocean-mask.bin`（~1.05MB，提交进仓库；掩码公开无妨）

**Interfaces:**
- Consumes: CMEMS 凭据已在 `~/.copernicusmarine/`（本机已登录）
- Produces: `make_safe_mask(ocean: np.ndarray) -> np.ndarray`（bool (nLat,nLon) → 3×3 腐蚀后 bool，经度环绕、纬度边界视为陆）；`web/public/ocean-mask.bin`（位序见 Global Constraints）

- [ ] **Step 1: 初始化 uv 工程**

`simulation/pyproject.toml`：

```toml
[project]
name = "drift-bottle-simulation"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "copernicusmarine>=2",
  "xarray>=2024",
  "numpy>=2",
  "h5netcdf>=1",
  "requests>=2",
]

[dependency-groups]
dev = ["pytest>=8", "black>=24"]
```

```bash
cd simulation && uv sync
```

- [ ] **Step 2: 写腐蚀函数的失败测试**

`simulation/tests/test_make_mask.py`：

```python
import numpy as np
from make_mask import make_safe_mask


def test_erosion_shrinks_coast():
    # 6x6：全海，中间一格陆地 → 陆地周围 8 格都不安全
    ocean = np.ones((6, 6), bool)
    ocean[3, 3] = False
    safe = make_safe_mask(ocean)
    assert not safe[3, 3]
    assert not safe[2, 2] and not safe[4, 4] and not safe[3, 2]
    assert safe[1, 1]  # 离陆地2格，安全


def test_lat_boundary_is_land():
    ocean = np.ones((4, 4), bool)
    safe = make_safe_mask(ocean)
    assert not safe[0].any() and not safe[-1].any()  # 南北边界行不安全


def test_lon_wraps():
    # 经度环绕：ix=0 的陆地影响 ix=W-1
    ocean = np.ones((5, 8), bool)
    ocean[2, 0] = False
    safe = make_safe_mask(ocean)
    assert not safe[2, 7]
```

- [ ] **Step 3: 运行确认失败**

Run: `cd simulation && uv run pytest tests/test_make_mask.py -v`
Expected: FAIL（make_mask 不存在）

- [ ] **Step 4: 实现 make_mask.py**

```python
"""从 CMEMS 全球日均流场生成「安全投放海域」位图。

安全格：自身及 8 邻域全为海（3x3 腐蚀，即 spec 的向海收缩一格）。
位序：idx = iy*nLon + ix，np.packbits 默认 big 位序，与 web/src/ocean.ts 一致。
用法：uv run python make_mask.py
"""

import pathlib

import numpy as np
import xarray as xr

HERE = pathlib.Path(__file__).parent
NC = HERE / "mask_source.nc"
OUT = HERE.parent / "web" / "public" / "ocean-mask.bin"
DATASET_ID = "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m"


def make_safe_mask(ocean: np.ndarray) -> np.ndarray:
    """3x3 腐蚀。经度（axis=1）环绕，纬度（axis=0）边界视为陆地。"""
    safe = ocean.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            s = np.roll(ocean, dx, axis=1)  # 经度环绕
            if dy > 0:
                s = np.vstack([np.zeros((dy, s.shape[1]), bool), s[:-dy]])
            elif dy < 0:
                s = np.vstack([s[-dy:], np.zeros((-dy, s.shape[1]), bool)])
            safe &= s
    return safe


def fetch_one_day():
    if NC.exists():
        return
    import copernicusmarine

    copernicusmarine.subset(
        dataset_id=DATASET_ID,
        variables=["uo"],
        start_datetime="2026-08-01",
        end_datetime="2026-08-01",
        minimum_depth=0,
        maximum_depth=1,
        output_filename=str(NC),
    )


def main():
    fetch_one_day()
    ds = xr.open_dataset(NC)
    if "depth" in ds.dims:
        ds = ds.isel(depth=0)
    ds = ds.squeeze(drop=True)
    u = ds.uo.values  # (lat, lon)
    lat, lon = ds.latitude.values, ds.longitude.values
    assert u.shape == (2041, 4320), f"网格形状异常: {u.shape}"
    assert abs(lat[0] - (-80)) < 0.01 and abs(lon[0] - (-180)) < 0.01, "网格原点异常"
    safe = make_safe_mask(~np.isnan(u))
    np.packbits(safe, axis=None).tofile(OUT)
    print(f"安全海格占比 {safe.mean():.1%}, 已写 {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: 测试通过后生成真实掩码**

Run: `cd simulation && uv run pytest tests/test_make_mask.py -v`
Expected: PASS

Run: `cd simulation && uv run python make_mask.py`（下载 ~35MB，需几分钟）
Expected: 输出安全海格占比 ~60-70%，`web/public/ocean-mask.bin` 大小 1,102,140 bytes

- [ ] **Step 6: black 格式化并提交**

```bash
/opt/homebrew/bin/black simulation/
printf 'simulation/mask_source.nc\nsimulation/.venv/\n*.egg-info/\n' >> .gitignore
git add simulation web/public/ocean-mask.bin .gitignore
git commit -m "feat(simulation): 生成全球安全投放海域位图"
```

---

### Task 5: 内容审核（moderation.ts）

**Files:**
- Create: `web/src/moderation.ts`
- Test: `web/test/moderation.test.ts`

**Interfaces:**
- Produces: `moderate(ai: Ai, content: string): Promise<"safe" | "unsafe" | "unavailable">`（Llama Guard 3；异常/不可解析 → "unavailable"，调用方按 fail-closed 处理）

- [ ] **Step 1: 写失败测试**

`web/test/moderation.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { moderate } from "../src/moderation";

const fakeAi = (impl: () => Promise<unknown>) => ({ run: impl }) as unknown as Ai;

describe("moderate", () => {
  it("safe 判定", async () => {
    const ai = fakeAi(async () => ({ response: "safe" }));
    expect(await moderate(ai, "你好，大海")).toBe("safe");
  });
  it("unsafe 判定", async () => {
    const ai = fakeAi(async () => ({ response: "unsafe\nS1" }));
    expect(await moderate(ai, "bad")).toBe("unsafe");
  });
  it("异常 → unavailable（fail-closed）", async () => {
    const ai = fakeAi(async () => { throw new Error("boom"); });
    expect(await moderate(ai, "x")).toBe("unavailable");
  });
  it("响应不可解析 → unavailable", async () => {
    const ai = fakeAi(async () => ({ response: "???" }));
    expect(await moderate(ai, "x")).toBe("unavailable");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd web && npm test`
Expected: FAIL

- [ ] **Step 3: 实现**

`web/src/moderation.ts`：

```ts
export type ModerationResult = "safe" | "unsafe" | "unavailable";

export async function moderate(ai: Ai, content: string): Promise<ModerationResult> {
  try {
    const res = (await ai.run("@cf/meta/llama-guard-3-8b" as never, {
      messages: [{ role: "user", content }],
    } as never)) as { response?: string };
    const text = (res?.response ?? "").trim().toLowerCase();
    if (text.startsWith("safe")) return "safe";
    if (text.startsWith("unsafe")) return "unsafe";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd web && npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/moderation.ts web/test/moderation.test.ts
git commit -m "feat(web): Llama Guard 内容审核（fail-closed）"
```

---

### Task 6: API — 投瓶与追踪

**Files:**
- Create: `web/src/index.ts`
- Test: `web/test/api-drop-track.test.ts`

**Interfaces:**
- Consumes: `newToken`/`newPublicId`（Task 2）、`haversineKm`/`bboxAround`（Task 2）、`getMask`/`setMask`/`OceanMask`（Task 3）、`moderate`（Task 5）
- Produces: Hono app（默认导出）；`type Env = { DB: D1Database; AI: Ai; ASSETS: Fetcher }`；`POST /api/bottles` 与 `GET /api/track/:token`（响应结构见代码）；后续 Task 7 在同一 `index.ts` 中追加路由

- [ ] **Step 1: 写失败测试**

`web/test/api-drop-track.test.ts`（用合成掩码 + 假 AI，`env` 来自 cloudflare:test）：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd web && npm test`
Expected: FAIL（index.ts 不存在）

- [ ] **Step 3: 实现 index.ts（本任务只含投瓶/追踪 + /b/* 静态回退）**

`web/src/index.ts`：

```ts
import { Hono } from "hono";
import type { Context } from "hono";
import { newToken, newPublicId } from "./ids";
import { haversineKm, bboxAround } from "./geo";
import { getMask } from "./ocean";
import { moderate } from "./moderation";

export type Env = { DB: D1Database; AI: Ai; ASSETS: Fetcher };

const app = new Hono<{ Bindings: Env }>();
const PICKUP_RADIUS_KM = 30;

type C = Context<{ Bindings: Env }>;
const err = (c: C, status: 400 | 403 | 404 | 409 | 422 | 503, code: string, message: string) =>
  c.json({ error: { code, message } }, status);
const now = () => new Date().toISOString();

function validCoords(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === "number" && typeof lon === "number" &&
    isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon as number) <= 180
  );
}
function validContent(content: unknown): content is string {
  return typeof content === "string" && content.trim().length > 0 && content.length <= 500;
}

/** 审核 + 通过校验的公共前置。返回 Response 表示已出错。 */
async function checkSubmission(c: C, content: unknown, lat: unknown, lon: unknown) {
  if (!validContent(content)) return err(c, 400, "bad_content", "内容不能为空且不超过500字");
  if (!validCoords(lat, lon)) return err(c, 400, "bad_coords", "坐标不合法");
  const mod = await moderate(c.env.AI, content as string);
  if (mod === "unavailable") return err(c, 503, "moderation_unavailable", "审核服务暂不可用，请稍后再试");
  if (mod === "unsafe") return err(c, 422, "rejected", "内容未通过审核");
  return null;
}

app.post("/api/bottles", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { content, lat, lon } = body as Record<string, unknown>;
  const bad = await checkSubmission(c, content, lat, lon);
  if (bad) return bad;
  const mask = await getMask(c.env);
  const snap = mask.snapToOcean(lat as number, lon as number);
  if (!snap) return err(c, 400, "no_ocean", "找不到可投放的海域");
  const t = now();
  const day = t.slice(0, 10);
  const token = newToken();
  const publicId = newPublicId();
  const ins = await c.env.DB.prepare(
    `INSERT INTO bottles (public_id, status, lat, lon, launched_at, simulated_to, distance_km, created_at)
     VALUES (?, 'drifting', ?, ?, ?, ?, 0, ?)`
  ).bind(publicId, snap.lat, snap.lon, t, day, t).run();
  const bottleId = ins.meta.last_row_id;
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO tokens (token, bottle_id, role, created_at) VALUES (?, ?, 'dropper', ?)`)
      .bind(token, bottleId, t),
    c.env.DB.prepare(`INSERT INTO messages (bottle_id, content, lat, lon, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(bottleId, (content as string).trim(), snap.lat, snap.lon, t),
    c.env.DB.prepare(`INSERT INTO track_points (bottle_id, ts, lat, lon) VALUES (?, ?, ?, ?)`)
      .bind(bottleId, t, snap.lat, snap.lon),
  ]);
  return c.json({ token, position: { lat: snap.lat, lon: snap.lon }, snapped_km: Math.round(snap.snappedKm * 10) / 10 });
});

app.get("/api/track/:token", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT b.* FROM tokens t JOIN bottles b ON b.id = t.bottle_id WHERE t.token = ?`
  ).bind(c.req.param("token")).first();
  if (!row) return err(c, 404, "not_found", "瓶子不存在");
  const msgs = await c.env.DB.prepare(
    `SELECT content, lat, lon, created_at FROM messages WHERE bottle_id = ? ORDER BY id`
  ).bind(row.id).all();
  const pts = await c.env.DB.prepare(
    `SELECT ts, lat, lon FROM track_points WHERE bottle_id = ? ORDER BY ts`
  ).bind(row.id).all();
  return c.json({
    status: row.status,
    position: { lat: row.lat, lon: row.lon },
    beached_at: row.beached_at,
    distance_km: row.distance_km,
    created_at: row.created_at,
    messages: msgs.results,
    track: pts.results,
  });
});

// 追踪页：/b/<token> 由前端 track.html 渲染
app.get("/b/*", (c) => c.env.ASSETS.fetch(new Request(new URL("/track.html", c.req.url))));

export default app;
```

- [ ] **Step 4: 运行确认通过**

Run: `cd web && npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/index.ts web/test/api-drop-track.test.ts
git commit -m "feat(web): 投瓶与追踪 API"
```

---

### Task 7: API — 附近搁浅瓶 / 读信 / 捡瓶

**Files:**
- Modify: `web/src/index.ts`（在 `/b/*` 路由之前追加 3 个路由）
- Test: `web/test/api-pickup.test.ts`

**Interfaces:**
- Consumes: Task 6 的 app、helpers（err/validCoords/checkSubmission/PICKUP_RADIUS_KM）
- Produces: `GET /api/nearby?lat=&lon=`、`POST /api/bottles/:publicId/read`、`POST /api/bottles/:publicId/pickup`（响应结构见代码）

- [ ] **Step 1: 写失败测试**

`web/test/api-pickup.test.ts`：

```ts
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
  it("漂流中的瓶子不可读不可捡（404）", async () => {
    await makeBeachedBottle();
    await env.DB.prepare(`UPDATE bottles SET status='drifting' WHERE public_id='beachedpub01'`).run();
    expect((await post("/api/bottles/beachedpub01/read", { lat: 31.05, lon: 121.1 })).status).toBe(404);
    expect((await post("/api/bottles/beachedpub01/pickup", { content: "x", lat: 31.05, lon: 121.1 })).status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd web && npm test`
Expected: api-pickup.test.ts FAIL（路由 404）

- [ ] **Step 3: 在 index.ts 追加路由（`/b/*` 之前）**

```ts
app.get("/api/nearby", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lon = Number(c.req.query("lon"));
  if (!validCoords(lat, lon)) return err(c, 400, "bad_coords", "坐标不合法");
  const box = bboxAround(lat, lon, PICKUP_RADIUS_KM);
  const rows = await c.env.DB.prepare(
    `SELECT public_id, lat, lon, beached_at, distance_km, created_at
     FROM bottles WHERE status = 'beached' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`
  ).bind(box.latMin, box.latMax, box.lonMin, box.lonMax).all();
  const bottles = rows.results
    .filter((b) => haversineKm(lat, lon, b.lat as number, b.lon as number) <= PICKUP_RADIUS_KM)
    .map((b) => ({
      public_id: b.public_id,
      lat: b.lat,
      lon: b.lon,
      beached_at: b.beached_at,
      distance_km: b.distance_km,
      days_at_sea: Math.max(0, Math.round(
        (Date.parse(b.beached_at as string) - Date.parse(b.created_at as string)) / 86400e3)),
    }));
  return c.json({ bottles });
});

/** 找到搁浅瓶并做距离校验；返回 Response 表示已出错。 */
async function findBeachedNearby(c: C, publicId: string, lat: unknown, lon: unknown) {
  if (!validCoords(lat, lon)) return err(c, 400, "bad_coords", "坐标不合法");
  const b = await c.env.DB.prepare(
    `SELECT id, status, lat, lon FROM bottles WHERE public_id = ?`
  ).bind(publicId).first();
  if (!b || b.status !== "beached") return err(c, 404, "not_found", "这里没有这只瓶子");
  if (haversineKm(lat as number, lon as number, b.lat as number, b.lon as number) > PICKUP_RADIUS_KM)
    return err(c, 403, "too_far", "你离这只瓶子太远了");
  return b as { id: number; lat: number; lon: number };
}

app.post("/api/bottles/:publicId/read", async (c) => {
  const { lat, lon } = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const b = await findBeachedNearby(c, c.req.param("publicId"), lat, lon);
  if (b instanceof Response) return b;
  const msgs = await c.env.DB.prepare(
    `SELECT content, lat, lon, created_at FROM messages WHERE bottle_id = ? ORDER BY id`
  ).bind(b.id).all();
  return c.json({ messages: msgs.results });
});

app.post("/api/bottles/:publicId/pickup", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { content, lat, lon } = body;
  const b = await findBeachedNearby(c, c.req.param("publicId"), lat, lon);
  if (b instanceof Response) return b;
  const bad = await checkSubmission(c, content, lat, lon);
  if (bad) return bad;
  const mask = await getMask(c.env);
  const snap = mask.snapToOcean(b.lat, b.lon); // 从搁浅点回海
  if (!snap) return err(c, 400, "no_ocean", "附近找不到海域");
  const t = now();
  const day = t.slice(0, 10);
  const upd = await c.env.DB.prepare(
    `UPDATE bottles SET status='drifting', lat=?, lon=?, beached_at=NULL, launched_at=?, simulated_to=?
     WHERE id = ? AND status = 'beached'`
  ).bind(snap.lat, snap.lon, t, day, b.id).run();
  if (upd.meta.changes === 0) return err(c, 409, "already_picked", "这只瓶子刚被别人捡走了");
  const token = newToken();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO tokens (token, bottle_id, role, created_at) VALUES (?, ?, 'picker', ?)`)
      .bind(token, b.id, t),
    c.env.DB.prepare(`INSERT INTO messages (bottle_id, content, lat, lon, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(b.id, (content as string).trim(), snap.lat, snap.lon, t),
    c.env.DB.prepare(`INSERT INTO track_points (bottle_id, ts, lat, lon) VALUES (?, ?, ?, ?)`)
      .bind(b.id, t, snap.lat, snap.lon),
  ]);
  return c.json({ token });
});
```

- [ ] **Step 4: 运行确认通过**

Run: `cd web && npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/index.ts web/test/api-pickup.test.ts
git commit -m "feat(web): 附近搁浅瓶/读信/捡瓶 API"
```

---

### Task 8: 前端 — 首页（投瓶 + 捡瓶）

**Files:**
- Create: `web/public/index.html`, `web/public/style.css`, `web/public/app.js`

**Interfaces:**
- Consumes: Task 6/7 的 API；`localStorage.myBottles`（JSON 数组 `[{token, created_at}]`，Task 9 的追踪页链接自它生成）

- [ ] **Step 1: 写页面**

`web/public/index.html`：

```html
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>漂流瓶 · 让真实的洋流带走你的信</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div id="map"></div>
<div id="panel">
  <h1>🍾 漂流瓶</h1>
  <p class="hint" id="hint">正在定位…（也可以点击地图选择位置）</p>
  <button id="dropBtn">写一封信，投进大海</button>
  <div id="nearby"></div>
  <div id="mine"></div>
</div>

<div id="modal" class="hidden">
  <div class="modal-box">
    <div id="modalBody"></div>
  </div>
</div>
<script src="/app.js"></script>
</body>
</html>
```

`web/public/style.css`：

```css
html, body { height: 100%; margin: 0; font: 15px/1.6 -apple-system, "PingFang SC", sans-serif; }
#map { position: absolute; inset: 0; }
#panel {
  position: absolute; top: 12px; right: 12px; z-index: 1000; width: 300px; max-height: 85vh;
  overflow-y: auto; background: rgba(255,255,255,.95); border-radius: 12px; padding: 14px 16px;
  box-shadow: 0 2px 12px rgba(0,0,0,.25);
}
#panel h1 { font-size: 20px; margin: 0 0 6px; }
.hint { color: #666; font-size: 13px; margin: 4px 0 10px; }
button { border: 0; border-radius: 8px; background: #1668dc; color: #fff; padding: 9px 14px;
  cursor: pointer; font-size: 15px; width: 100%; }
button:hover { background: #0f57bd; }
button.secondary { background: #f0f2f5; color: #333; }
.bottle-item { border-top: 1px solid #eee; padding: 8px 0; font-size: 14px; }
.bottle-item a { color: #1668dc; }
textarea { width: 100%; box-sizing: border-box; height: 120px; padding: 8px; font: inherit;
  border: 1px solid #ccc; border-radius: 8px; resize: vertical; }
#modal { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center; }
#modal.hidden { display: none; }
.modal-box { background: #fff; border-radius: 12px; padding: 18px; width: min(420px, 90vw);
  max-height: 80vh; overflow-y: auto; }
.letter { background: #f7f8fa; border-radius: 8px; padding: 10px; margin: 8px 0; white-space: pre-wrap; }
.letter .meta { color: #999; font-size: 12px; margin-top: 4px; }
.error { color: #d4380d; font-size: 13px; }
.token-link { word-break: break-all; background: #f0f7ff; padding: 8px; border-radius: 8px;
  display: block; margin: 8px 0; }
h3 { font-size: 16px; margin: 14px 0 6px; }
```

`web/public/app.js`：

```js
const map = L.map("map").setView([25, 140], 3);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap",
}).addTo(map);

let userPos = null;
let userMarker = null;

function setUserPos(lat, lon, label) {
  userPos = { lat, lon };
  if (userMarker) userMarker.remove();
  userMarker = L.marker([lat, lon]).addTo(map).bindPopup(label);
  document.getElementById("hint").textContent =
    `位置：${lat.toFixed(3)}, ${lon.toFixed(3)}（点击地图可修改）`;
  loadNearby();
}

navigator.geolocation?.getCurrentPosition(
  (p) => { setUserPos(p.coords.latitude, p.coords.longitude, "我的位置"); map.setView([p.coords.latitude, p.coords.longitude], 8); },
  () => { document.getElementById("hint").textContent = "定位失败，点击地图选择位置"; }
);
map.on("click", (e) => setUserPos(e.latlng.lat, e.latlng.lng, "已选位置"));

const modal = document.getElementById("modal");
const modalBody = document.getElementById("modalBody");
function showModal(html) { modalBody.innerHTML = html; modal.classList.remove("hidden"); }
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `请求失败(${res.status})`);
  return data;
}

// ---- 投瓶 ----
document.getElementById("dropBtn").onclick = () => {
  if (!userPos) return alert("请先允许定位，或点击地图选择位置");
  showModal(`
    <h3>写一封信</h3>
    <textarea id="letter" maxlength="500" placeholder="写点什么吧，最多500字。洋流会把它带向远方…"></textarea>
    <p class="error" id="dropErr"></p>
    <button id="submitDrop">投进大海</button>`);
  document.getElementById("submitDrop").onclick = async () => {
    try {
      const content = document.getElementById("letter").value;
      const data = await api("/api/bottles", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, lat: userPos.lat, lon: userPos.lon }),
      });
      saveMine(data.token);
      const url = `${location.origin}/b/${data.token}`;
      showModal(`
        <h3>🌊 瓶子已入海！</h3>
        <p>入海点距你 ${data.snapped_km} km。收好你的追踪链接（仅此一次，丢了找不回）：</p>
        <a class="token-link" href="${url}">${url}</a>
        <button onclick="navigator.clipboard.writeText('${url}')">复制链接</button>`);
      L.marker([data.position.lat, data.position.lon]).addTo(map).bindPopup("你的瓶子入海点").openPopup();
      map.setView([data.position.lat, data.position.lon], 7);
    } catch (e) { document.getElementById("dropErr").textContent = e.message; }
  };
};

// ---- 我的瓶子 ----
function saveMine(token) {
  const mine = JSON.parse(localStorage.myBottles || "[]");
  mine.push({ token, created_at: new Date().toISOString() });
  localStorage.myBottles = JSON.stringify(mine);
  renderMine();
}
function renderMine() {
  const mine = JSON.parse(localStorage.myBottles || "[]");
  document.getElementById("mine").innerHTML = mine.length
    ? `<h3>我的瓶子</h3>` + mine.map((b) =>
        `<div class="bottle-item"><a href="/b/${b.token}">🍾 ${b.created_at.slice(0, 10)} 投出的瓶子</a></div>`).join("")
    : "";
}
renderMine();

// ---- 附近搁浅瓶 ----
let nearbyLayer = L.layerGroup().addTo(map);
async function loadNearby() {
  if (!userPos) return;
  nearbyLayer.clearLayers();
  const el = document.getElementById("nearby");
  try {
    const { bottles } = await api(`/api/nearby?lat=${userPos.lat}&lon=${userPos.lon}`);
    el.innerHTML = `<h3>附近搁浅的瓶子（${bottles.length}）</h3>` + (bottles.length === 0
      ? `<p class="hint">30km 内暂时没有。常回来看看～</p>` : "");
    for (const b of bottles) {
      const item = document.createElement("div");
      item.className = "bottle-item";
      item.innerHTML = `🏝️ 漂了 ${b.days_at_sea} 天、${Math.round(b.distance_km)} km
        <button class="secondary" style="margin-top:6px">读信 / 捡起</button>`;
      item.querySelector("button").onclick = () => openBottle(b);
      el.appendChild(item);
      L.marker([b.lat, b.lon]).addTo(nearbyLayer)
        .bindPopup(`🏝️ 搁浅瓶：漂了 ${b.days_at_sea} 天`)
        .on("click", () => openBottle(b));
    }
  } catch (e) { el.innerHTML = `<p class="error">${e.message}</p>`; }
}

// ---- 读信 + 捡瓶 ----
async function openBottle(b) {
  try {
    const { messages } = await api(`/api/bottles/${b.public_id}/read`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat: userPos.lat, lon: userPos.lon }),
    });
    showModal(`
      <h3>🍾 瓶中信（${messages.length} 封）</h3>
      ${messages.map((m) => `<div class="letter">${escapeHtml(m.content)}
        <div class="meta">${m.created_at.slice(0, 10)}</div></div>`).join("")}
      <h3>写下你的回复，送它回大海</h3>
      <textarea id="reply" maxlength="500" placeholder="最多500字"></textarea>
      <p class="error" id="pickErr"></p>
      <button id="submitPick">回复并重新投放</button>`);
    document.getElementById("submitPick").onclick = async () => {
      try {
        const data = await api(`/api/bottles/${b.public_id}/pickup`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: document.getElementById("reply").value, lat: userPos.lat, lon: userPos.lon }),
        });
        saveMine(data.token);
        const url = `${location.origin}/b/${data.token}`;
        showModal(`
          <h3>🌊 它又出发了！</h3>
          <p>这是你的追踪链接，可以看它接下来漂向哪里：</p>
          <a class="token-link" href="${url}">${url}</a>`);
        loadNearby();
      } catch (e) { document.getElementById("pickErr").textContent = e.message; }
    };
  } catch (e) { alert(e.message); }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
```

- [ ] **Step 2: 本地冒烟验证**

Run: `cd web && npx wrangler dev`（另开进程），然后：

```bash
curl -s http://localhost:8787/ | grep -q "漂流瓶" && echo PAGE_OK
curl -s http://localhost:8787/app.js | grep -q "loadNearby" && echo JS_OK
```

Expected: 输出 PAGE_OK 与 JS_OK。浏览器打开 http://localhost:8787 手动确认：地图渲染、点击地图设置位置、投瓶弹窗出现（本地 AI 绑定不可用属预期，投瓶提交会 503 —— 审核 fail-closed 的表现，部署后验证完整链路）

- [ ] **Step 3: 提交**

```bash
git add web/public/index.html web/public/style.css web/public/app.js
git commit -m "feat(web): 首页（投瓶+附近捡瓶）"
```

---

### Task 9: 前端 — 追踪页

**Files:**
- Create: `web/public/track.html`, `web/public/track.js`

**Interfaces:**
- Consumes: `GET /api/track/:token`（Task 6）；路由 `/b/*` → track.html（Task 6 已配）

- [ ] **Step 1: 写页面**

`web/public/track.html`：

```html
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>瓶子去哪儿了 · 漂流瓶</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div id="map"></div>
<div id="panel">
  <h1>🍾 瓶子去哪儿了</h1>
  <div id="info">加载中…</div>
  <div id="letters"></div>
  <p><a href="/">← 回首页</a></p>
</div>
<script src="/track.js"></script>
</body>
</html>
```

`web/public/track.js`：

```js
const map = L.map("map").setView([25, 140], 3);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap",
}).addTo(map);

const token = location.pathname.split("/").pop();
const info = document.getElementById("info");

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

(async () => {
  const res = await fetch(`/api/track/${token}`);
  if (!res.ok) { info.innerHTML = `<p class="error">没有找到这只瓶子。链接是否完整？</p>`; return; }
  const d = await res.json();

  const days = Math.max(0, (Date.now() - Date.parse(d.created_at)) / 86400e3);
  info.innerHTML = `
    <p>状态：${d.status === "beached" ? "🏝️ 已搁浅，等待有缘人" : "🌊 正在漂流"}<br>
    启程：${d.created_at.slice(0, 10)}（${days.toFixed(0)} 天前）<br>
    里程：${Math.round(d.distance_km)} km</p>`;

  const pts = d.track.map((p) => [p.lat, p.lon]);
  if (pts.length > 1) {
    for (let i = 1; i < pts.length; i++) {
      const hue = 210 + (130 * i) / pts.length;
      L.polyline([pts[i - 1], pts[i]], { color: `hsl(${hue},85%,45%)`, weight: 3, opacity: 0.9 }).addTo(map);
    }
  }
  if (pts.length) {
    L.circleMarker(pts[0], { radius: 7, color: "#fff", fillColor: "#1668dc", fillOpacity: 1, weight: 2 })
      .addTo(map).bindPopup("入海点");
    const endIcon = d.status === "beached" ? "🏝️ 搁浅于此" : "🌊 目前在这里";
    L.marker([d.position.lat, d.position.lon]).addTo(map).bindPopup(endIcon).openPopup();
    map.fitBounds(L.latLngBounds([...pts, [d.position.lat, d.position.lon]]).pad(0.2));
  }

  document.getElementById("letters").innerHTML =
    `<h3>瓶中信（${d.messages.length} 封）</h3>` +
    d.messages.map((m) => `<div class="letter">${escapeHtml(m.content)}
      <div class="meta">${m.created_at.slice(0, 10)}</div></div>`).join("");
})();
```

- [ ] **Step 2: 冒烟验证**

Run（wrangler dev 运行中）:

```bash
curl -s http://localhost:8787/b/anytokenhere | grep -q "瓶子去哪儿了" && echo TRACK_PAGE_OK
```

Expected: TRACK_PAGE_OK（页面能出，数据 404 时显示「没有找到这只瓶子」属预期）

- [ ] **Step 3: 提交**

```bash
git add web/public/track.html web/public/track.js
git commit -m "feat(web): 追踪页"
```

---

### Task 10: Python 模拟核心（currents.py + integrator.py）

**Files:**
- Create: `simulation/currents.py`, `simulation/integrator.py`
- Test: `simulation/tests/test_integrator.py`

**Interfaces:**
- Produces:
  - `currents.DATASET_ID: str`；`currents.download_currents(start_date: date, end_date: date, out_path: Path) -> None`
  - `currents.CurrentField(ds: xr.Dataset)`：`.available_days() -> list[date]`；`.velocity(t_sec: float, lats: np.ndarray, lons: np.ndarray) -> tuple[np.ndarray, np.ndarray]`（陆地/邻域含 NaN → NaN；经度环绕；时间线性插值、端点截断；日均场时间戳视为当日 12:00 UTC）
  - `integrator.advance_day(field, day: date, lats, lons) -> DayResult`，`DayResult(lats, lons, step_km, beached_hour, snapshots)`：`beached_hour[i]` int（-1 未搁浅，否则 0-23）；`snapshots` 为 `[(hour, lats, lons)]`，hour ∈ {6,12,18,24}，搁浅瓶在快照中保持搁浅位置
- Consumes: Task 4 的 pyproject（同一工程）

- [ ] **Step 1: 写失败测试**

`simulation/tests/test_integrator.py`（合成流场，不下载数据）：

```python
from datetime import date

import numpy as np
import xarray as xr

from currents import CurrentField
from integrator import advance_day


def synthetic_ds(u_val=0.5, v_val=0.0, days=("2026-08-01", "2026-08-02")):
    """20x20 全球子网格 0..19E/0..19N 1°，可指定常速；边界外自然 NaN。"""
    lat = np.arange(0.0, 20.0)
    lon = np.arange(0.0, 20.0)
    t = np.array([np.datetime64(d) for d in days])
    u = np.full((len(t), 20, 20), u_val)
    v = np.full((len(t), 20, 20), v_val)
    u[:, :, 0] = np.nan  # 西边一列陆地
    v[:, :, 0] = np.nan
    return xr.Dataset(
        {"uo": (("time", "latitude", "longitude"), u),
         "vo": (("time", "latitude", "longitude"), v)},
        coords={"time": t, "latitude": lat, "longitude": lon},
    )


def test_eastward_drift_distance():
    # 0.5 m/s 向东漂 24h ≈ 43.2 km
    field = CurrentField(synthetic_ds())
    r = advance_day(field, date(2026, 8, 1), np.array([10.0]), np.array([10.0]))
    assert r.beached_hour[0] == -1
    assert abs(r.step_km[0] - 43.2) < 2.0
    assert r.lats[0] == 10.0  # 纯东向，纬度不变
    assert r.lons[0] > 10.3
    assert [h for h, _, _ in r.snapshots] == [6, 12, 18, 24]


def test_westward_bottle_beaches():
    # 向西 1.0 m/s，从 lon=2 出发，撞上 lon=0 陆地列 → 搁浅
    field = CurrentField(synthetic_ds(u_val=-1.0))
    r = advance_day(field, date(2026, 8, 1), np.array([10.0]), np.array([2.0]))
    assert r.beached_hour[0] >= 0
    assert r.lons[0] > 0.5  # 停在最后一个海上位置，不进陆地


def test_velocity_time_interp_and_clamp():
    ds = synthetic_ds()
    ds["uo"].values[1, :, :] = 1.0  # 第二天流速翻倍
    field = CurrentField(ds)
    day1_noon = np.datetime64("2026-08-01T12:00").astype("datetime64[s]").astype(float)
    day2_noon = np.datetime64("2026-08-02T12:00").astype("datetime64[s]").astype(float)
    u_mid, _ = field.velocity((day1_noon + day2_noon) / 2, np.array([10.0]), np.array([10.0]))
    assert abs(u_mid[0] - 0.75) < 0.01  # 两天中点 → 线性插值
    u_before, _ = field.velocity(day1_noon - 86400, np.array([10.0]), np.array([10.0]))
    assert abs(u_before[0] - 0.5) < 0.01  # 范围外截断到端点
```

- [ ] **Step 2: 运行确认失败**

Run: `cd simulation && uv run pytest tests/test_integrator.py -v`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 currents.py**

```python
"""CMEMS 全球表层日均流场：下载与插值。"""

from __future__ import annotations

import pathlib
from datetime import date, datetime, timezone

import numpy as np
import xarray as xr

DATASET_ID = "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m"


def download_currents(start_date: date, end_date: date, out_path: pathlib.Path) -> None:
    import copernicusmarine

    copernicusmarine.subset(
        dataset_id=DATASET_ID,
        variables=["uo", "vo"],
        start_datetime=start_date.isoformat(),
        end_datetime=end_date.isoformat(),
        minimum_depth=0,
        maximum_depth=1,
        output_filename=str(out_path),
    )


def _day_noon_sec(d: np.datetime64) -> float:
    """日均场代表时刻：当日 12:00 UTC 的 epoch 秒。"""
    day = d.astype("datetime64[D]")
    return day.astype("datetime64[s]").astype(float) + 43200.0


class CurrentField:
    """空间双线性 + 时间线性插值（端点截断）。经度补列环绕。陆地→NaN。"""

    def __init__(self, ds: xr.Dataset):
        if "depth" in ds.dims:
            ds = ds.isel(depth=0)
        ds = ds.squeeze(drop=True)
        lon = ds.longitude.values.astype(float)
        self.lat = ds.latitude.values.astype(float)
        u = ds.uo.values
        v = ds.vo.values
        if u.ndim == 2:  # 单天文件无 time 维
            u, v = u[None], v[None]
            times = np.atleast_1d(ds.time.values)
        else:
            times = ds.time.values
        # 经度环绕：末尾补第一列
        self.lon = np.concatenate([lon, [lon[0] + 360.0]])
        self.u = np.concatenate([u, u[:, :, :1]], axis=2)
        self.v = np.concatenate([v, v[:, :, :1]], axis=2)
        self.t = np.array([_day_noon_sec(x) for x in times])
        self.days = [
            datetime.fromtimestamp(s - 43200.0, tz=timezone.utc).date() for s in self.t
        ]

    def available_days(self) -> list[date]:
        return list(self.days)

    def _interp_2d(self, arr2d: np.ndarray, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
        lons = np.where(lons < self.lon[0], lons + 360.0, lons)
        lons = np.where(lons >= self.lon[-1], lons - 360.0, lons)
        ix = np.clip(np.searchsorted(self.lon, lons) - 1, 0, len(self.lon) - 2)
        iy = np.clip(np.searchsorted(self.lat, lats) - 1, 0, len(self.lat) - 2)
        wx = (lons - self.lon[ix]) / (self.lon[ix + 1] - self.lon[ix])
        wy = (lats - self.lat[iy]) / (self.lat[iy + 1] - self.lat[iy])
        out_of_grid = (lats < self.lat[0]) | (lats > self.lat[-1])
        val = (
            arr2d[iy, ix] * (1 - wx) * (1 - wy)
            + arr2d[iy, ix + 1] * wx * (1 - wy)
            + arr2d[iy + 1, ix] * (1 - wx) * wy
            + arr2d[iy + 1, ix + 1] * wx * wy
        )
        return np.where(out_of_grid, np.nan, val)

    def velocity(self, t_sec: float, lats: np.ndarray, lons: np.ndarray):
        t_sec = float(np.clip(t_sec, self.t[0], self.t[-1]))
        ti = int(np.clip(np.searchsorted(self.t, t_sec) - 1, 0, max(len(self.t) - 2, 0)))
        if len(self.t) == 1:
            return self._interp_2d(self.u[0], lats, lons), self._interp_2d(self.v[0], lats, lons)
        wt = (t_sec - self.t[ti]) / (self.t[ti + 1] - self.t[ti])
        u = (1 - wt) * self._interp_2d(self.u[ti], lats, lons) + wt * self._interp_2d(self.u[ti + 1], lats, lons)
        v = (1 - wt) * self._interp_2d(self.v[ti], lats, lons) + wt * self._interp_2d(self.v[ti + 1], lats, lons)
        return u, v
```

- [ ] **Step 4: 实现 integrator.py**

```python
"""向量化 RK2 漂移积分与搁浅判定。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone

import numpy as np

M_PER_DEG = 111320.0
DT = 3600.0
STEPS = 24


@dataclass
class DayResult:
    lats: np.ndarray
    lons: np.ndarray
    step_km: np.ndarray          # 当日漂流里程
    beached_hour: np.ndarray     # -1 未搁浅；否则 0-23
    snapshots: list              # [(hour, lats, lons)] hour ∈ {6,12,18,24}


def _haversine_km(lat1, lon1, lat2, lon2):
    rad = np.pi / 180
    dlat = (lat2 - lat1) * rad
    dlon = (lon2 - lon1) * rad
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1 * rad) * np.cos(lat2 * rad) * np.sin(dlon / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(a))


def _wrap_lon(lons):
    return (lons + 180.0) % 360.0 - 180.0


def advance_day(field, day: date, lats: np.ndarray, lons: np.ndarray) -> DayResult:
    lats = lats.astype(float).copy()
    lons = lons.astype(float).copy()
    n = len(lats)
    active = np.ones(n, bool)
    beached_hour = np.full(n, -1, dtype=int)
    step_km = np.zeros(n)
    snapshots = []
    day_start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp()

    for h in range(STEPS):
        t = day_start + h * DT
        u1, v1 = field.velocity(t, lats, lons)
        hit = active & (np.isnan(u1) | np.isnan(v1))
        beached_hour[hit] = h
        active &= ~hit
        if active.any():
            cos_lat = np.cos(np.radians(lats))
            mid_lat = lats + v1 * DT / M_PER_DEG
            mid_lon = _wrap_lon(lons + u1 * DT / (M_PER_DEG * cos_lat))
            u2, v2 = field.velocity(t + DT, mid_lat, mid_lon)
            u2 = np.where(np.isnan(u2), u1, u2)
            v2 = np.where(np.isnan(v2), v1, v2)
            u = (u1 + u2) / 2
            v = (v1 + v2) / 2
            new_lat = np.clip(lats + v * DT / M_PER_DEG, -89.9, 89.9)
            new_lon = _wrap_lon(lons + u * DT / (M_PER_DEG * cos_lat))
            dist = _haversine_km(lats, lons, new_lat, new_lon)
            lats = np.where(active, new_lat, lats)
            lons = np.where(active, new_lon, lons)
            step_km += np.where(active, dist, 0.0)
        if (h + 1) % 6 == 0:
            snapshots.append((h + 1, lats.copy(), lons.copy()))

    return DayResult(lats, lons, step_km, beached_hour, snapshots)
```

- [ ] **Step 5: 运行确认通过，black 格式化，提交**

Run: `cd simulation && uv run pytest tests/test_integrator.py -v && uv run black .`
Expected: 全部 PASS

```bash
git add simulation/currents.py simulation/integrator.py simulation/tests/test_integrator.py
git commit -m "feat(simulation): 流场插值与向量化 RK2 积分"
```

---

### Task 11: D1 客户端与每日任务（d1.py + advance.py）

**Files:**
- Create: `simulation/d1.py`, `simulation/advance.py`
- Test: `simulation/tests/test_advance.py`

**Interfaces:**
- Consumes: `CurrentField`/`download_currents`（Task 10）、`advance_day`/`DayResult`（Task 10）
- Produces:
  - `d1.D1Client(account_id, database_id, api_token)`：`.query(sql: str, params: list | None = None) -> list[dict]`（Cloudflare REST `/d1/database/{id}/query`；HTTP 或业务失败抛 RuntimeError）
  - `advance.run(d1, field) -> None`（核心逻辑，可注入测试替身）；`advance.writeback_sql(day, bottles, result) -> str`（纯函数：一天的全部 UPDATE/INSERT + meta 水位线，单请求执行）；`advance.main()`（环境变量 `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_D1_DATABASE_ID` / `CLOUDFLARE_API_TOKEN`）

- [ ] **Step 1: 写失败测试**

`simulation/tests/test_advance.py`：

```python
from datetime import date

import numpy as np

from advance import run, writeback_sql
from currents import CurrentField
from tests.test_integrator import synthetic_ds


class FakeD1:
    def __init__(self, bottles):
        self.bottles = bottles
        self.executed = []

    def query(self, sql, params=None):
        self.executed.append(sql)
        if sql.strip().startswith("SELECT"):
            return self.bottles
        return []


def bottle(id_, lat, lon, simulated_to, dist=0.0):
    return {"id": id_, "lat": lat, "lon": lon, "distance_km": dist, "simulated_to": simulated_to}


def test_advances_eligible_bottle_and_writes_watermark():
    field = CurrentField(synthetic_ds(days=("2026-08-01", "2026-08-02")))
    d1 = FakeD1([bottle(1, 10.0, 10.0, "2026-07-31")])
    run(d1, field)
    writes = [s for s in d1.executed if "UPDATE bottles" in s]
    assert len(writes) == 2  # 两个可模拟日各一次写回
    assert "simulated_to < '2026-08-01'" in writes[0]
    assert "sim_watermark" in writes[0]
    assert "INSERT OR IGNORE INTO track_points" in writes[0]


def test_skips_already_simulated_days():
    field = CurrentField(synthetic_ds(days=("2026-08-01", "2026-08-02")))
    d1 = FakeD1([bottle(1, 10.0, 10.0, "2026-08-02")])  # 已模拟到最新
    run(d1, field)
    assert not any("UPDATE bottles" in s for s in d1.executed)


def test_beached_bottle_written_with_status():
    field = CurrentField(synthetic_ds(u_val=-1.0, days=("2026-08-01",)))
    d1 = FakeD1([bottle(1, 10.0, 2.0, "2026-07-31")])  # 向西必搁浅
    run(d1, field)
    w = next(s for s in d1.executed if "UPDATE bottles" in s)
    assert "status='beached'" in w
    assert "beached_at=" in w


def test_writeback_sql_is_deterministic():
    field = CurrentField(synthetic_ds(days=("2026-08-01",)))
    from integrator import advance_day

    b = [bottle(7, 10.0, 10.0, "2026-07-31")]
    r = advance_day(field, date(2026, 8, 1), np.array([10.0]), np.array([10.0]))
    sql = writeback_sql(date(2026, 8, 1), b, r)
    assert "WHERE id = 7 AND simulated_to < '2026-08-01'" in sql
    assert sql.count("INSERT OR IGNORE INTO track_points") == 1  # 单语句多 VALUES
    assert "(7, '2026-08-01T06:00:00Z'" in sql
```

- [ ] **Step 2: 运行确认失败**

Run: `cd simulation && uv run pytest tests/test_advance.py -v`
Expected: FAIL

- [ ] **Step 3: 实现 d1.py**

```python
"""Cloudflare D1 REST 客户端。"""

from __future__ import annotations

import requests


class D1Client:
    def __init__(self, account_id: str, database_id: str, api_token: str):
        self.url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/d1/database/{database_id}/query"
        )
        self.headers = {"Authorization": f"Bearer {api_token}"}

    def query(self, sql: str, params: list | None = None) -> list[dict]:
        resp = requests.post(
            self.url, headers=self.headers, json={"sql": sql, "params": params or []}, timeout=120
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise RuntimeError(f"D1 query failed: {data.get('errors')}")
        return data["result"][0].get("results", []) if data.get("result") else []
```

- [ ] **Step 4: 实现 advance.py**

```python
"""每日漂流任务：拉流场 → 推进 drifting 瓶子 → 写回 D1。

幂等：UPDATE 带 simulated_to < '当日' 护栏；track_points 用 INSERT OR IGNORE。
数值均为服务端生成（非用户输入），可安全拼入 SQL 字面量。
"""

from __future__ import annotations

import os
import pathlib
import sys
from datetime import date, timedelta, timezone, datetime

import numpy as np

from currents import CurrentField, download_currents
from d1 import D1Client
from integrator import DayResult, advance_day

DATA = pathlib.Path(__file__).parent / "currents_global.nc"


def writeback_sql(day: date, bottles: list[dict], result: DayResult) -> str:
    """一天的全量写回：每瓶一条守卫 UPDATE + 轨迹批量 INSERT + 水位线。"""
    d = day.isoformat()
    stmts = []
    track_values = []
    for i, b in enumerate(bottles):
        lat, lon = float(result.lats[i]), float(result.lons[i])
        dist = float(b["distance_km"]) + float(result.step_km[i])
        if result.beached_hour[i] >= 0:
            beached_ts = f"{d}T{int(result.beached_hour[i]):02d}:00:00Z"
            status = f"status='beached', beached_at='{beached_ts}'"
        else:
            status = "status='drifting'"
        stmts.append(
            f"UPDATE bottles SET {status}, lat={lat:.5f}, lon={lon:.5f}, "
            f"distance_km={dist:.2f}, simulated_to='{d}' "
            f"WHERE id = {int(b['id'])} AND simulated_to < '{d}'"
        )
        for hour, slats, slons in result.snapshots:
            if result.beached_hour[i] >= 0 and hour > result.beached_hour[i] + 1:
                continue  # 搁浅后的快照不再记录
            ts = (
                f"{d}T{hour:02d}:00:00Z"
                if hour < 24
                else f"{(day + timedelta(days=1)).isoformat()}T00:00:00Z"
            )
            track_values.append(
                f"({int(b['id'])}, '{ts}', {float(slats[i]):.5f}, {float(slons[i]):.5f})"
            )
    if track_values:
        stmts.append(
            "INSERT OR IGNORE INTO track_points (bottle_id, ts, lat, lon) VALUES "
            + ", ".join(track_values)
        )
    stmts.append(
        f"INSERT INTO meta (key, value) VALUES ('sim_watermark', '{d}') "
        f"ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    return ";\n".join(stmts)


def run(d1, field) -> None:
    bottles = d1.query(
        "SELECT id, lat, lon, distance_km, simulated_to FROM bottles WHERE status = 'drifting'"
    )
    if not bottles:
        print("[advance] 没有漂流中的瓶子")
        return
    for day in field.available_days():
        d = day.isoformat()
        todo = [b for b in bottles if b["simulated_to"] < d]
        if not todo:
            continue
        lats = np.array([b["lat"] for b in bottles], dtype=float)
        lons = np.array([b["lon"] for b in bottles], dtype=float)
        idx = [i for i, b in enumerate(bottles) if b["simulated_to"] < d]
        result = advance_day(field, day, lats[idx], lons[idx])
        d1.query(writeback_sql(day, todo, result))
        beached = int((result.beached_hour >= 0).sum())
        print(f"[advance] {d}: 推进 {len(todo)} 只, 新搁浅 {beached} 只")
        # 更新内存状态供下一天继续
        for j, b in enumerate(todo):
            b["lat"], b["lon"] = float(result.lats[j]), float(result.lons[j])
            b["distance_km"] = float(b["distance_km"]) + float(result.step_km[j])
            b["simulated_to"] = d
            if result.beached_hour[j] >= 0:
                b["simulated_to"] = "9999-12-31"  # 已搁浅，后续天不再入 todo
    print("[advance] 完成")


def main() -> None:
    d1 = D1Client(
        os.environ["CLOUDFLARE_ACCOUNT_ID"],
        os.environ["CLOUDFLARE_D1_DATABASE_ID"],
        os.environ["CLOUDFLARE_API_TOKEN"],
    )
    rows = d1.query(
        "SELECT MIN(simulated_to) AS m FROM bottles WHERE status = 'drifting'"
    )
    if not rows or rows[0]["m"] is None:
        print("[advance] 没有漂流中的瓶子，退出")
        return
    start = date.fromisoformat(rows[0]["m"]) + timedelta(days=1)
    end = datetime.now(timezone.utc).date()
    if start > end:
        print("[advance] 已是最新，退出")
        return
    if DATA.exists():
        DATA.unlink()
    download_currents(start, end, DATA)
    import xarray as xr

    field = CurrentField(xr.open_dataset(DATA))
    run(d1, field)


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: 运行确认通过，black 格式化，提交**

Run: `cd simulation && uv run pytest -v && uv run black .`
Expected: 全部 PASS（含此前任务的测试）

```bash
printf 'simulation/currents_global.nc\n' >> .gitignore
git add simulation/d1.py simulation/advance.py simulation/tests/test_advance.py .gitignore
git commit -m "feat(simulation): D1 客户端与每日推进任务（幂等写回）"
```

---

### Task 12: GitHub Actions 每日工作流

**Files:**
- Create: `.github/workflows/daily-drift.yml`, `README.md`

**Interfaces:**
- Consumes: `advance.main()`（Task 11）；GitHub Secrets：`CMEMS_USERNAME`、`CMEMS_PASSWORD`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID`、`CLOUDFLARE_API_TOKEN`（Task 13 配置）

- [ ] **Step 1: 写 workflow**

`.github/workflows/daily-drift.yml`：

```yaml
name: daily-drift

on:
  schedule:
    - cron: "0 6 * * *" # 06:00 UTC，CMEMS 前一日分析场发布后
  workflow_dispatch:

jobs:
  drift:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - name: 安装依赖
        working-directory: simulation
        run: uv sync
      - name: 推进瓶子
        working-directory: simulation
        run: uv run python advance.py
        env:
          COPERNICUSMARINE_SERVICE_USERNAME: ${{ secrets.CMEMS_USERNAME }}
          COPERNICUSMARINE_SERVICE_PASSWORD: ${{ secrets.CMEMS_PASSWORD }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_D1_DATABASE_ID: ${{ secrets.CLOUDFLARE_D1_DATABASE_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

- [ ] **Step 2: 写 README（简要：产品说明 + 本地开发 + 部署步骤索引）**

```markdown
# 🍾 漂流瓶

匿名漂流瓶：写一封信投进大海，真实洋流带它漂流；搁浅后被岸边的人捡起、回复、再投回。

- 前端+API：Cloudflare Workers (Hono) + D1 + Workers AI（内容审核）
- 洋流模拟：CMEMS 全球表层日均流场，GitHub Actions 每日推进，Python/numpy RK2 积分
- 设计文档：docs/superpowers/specs/2026-08-04-drift-bottle-design.md

## 本地开发

    cd web && npm i && npm test && npx wrangler dev
    cd simulation && uv sync && uv run pytest

## 部署

    cd web
    npx wrangler d1 create drift-bottle   # 把 database_id 填入 wrangler.toml
    npx wrangler d1 migrations apply drift-bottle --remote
    npx wrangler deploy

GitHub Secrets（Actions 用）：CMEMS_USERNAME / CMEMS_PASSWORD /
CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_DATABASE_ID / CLOUDFLARE_API_TOKEN
```

- [ ] **Step 3: 提交**

```bash
git add .github README.md
git commit -m "ci: 每日漂流工作流与 README"
```

---

### Task 13: 部署上线与端到端验证

前置：需要用户交互的步骤已标注（**[用户]**）。

**Files:**
- Modify: `web/wrangler.toml`（回填 database_id）

- [ ] **Step 1: [用户] Cloudflare 登录**

用户在会话输入框执行：`! cd web && npx wrangler login`

- [ ] **Step 2: 创建 D1 并回填配置**

```bash
cd web && npx wrangler d1 create drift-bottle
# 把输出的 database_id 写入 wrangler.toml 替换 TBD-AFTER-D1-CREATE
npx wrangler d1 migrations apply drift-bottle --remote
```

- [ ] **Step 3: 部署 Worker**

```bash
npx wrangler deploy
```

Expected: 输出 `https://drift-bottle.<subdomain>.workers.dev`

- [ ] **Step 4: 线上 E2E 冒烟（真实 Workers AI + 真实掩码）**

```bash
BASE=https://drift-bottle.<subdomain>.workers.dev
# 上海坐标投瓶（内陆点，应吸附入海）
curl -s -X POST $BASE/api/bottles -H 'content-type: application/json' \
  -d '{"content":"你好，大海！第一只瓶子。","lat":31.23,"lon":121.47}'
# 期望: {"token":"...","position":{...},"snapped_km":>0}
curl -s $BASE/api/track/<token>
# 期望: status=drifting, messages 1 封, track 1 点
curl -s "$BASE/api/nearby?lat=31.0&lon=122.0"
# 期望: {"bottles":[]}（还没有搁浅瓶）
```

浏览器打开 $BASE 手动确认首页地图、投瓶、追踪页完整可用。

- [ ] **Step 5: 中文审核效果验证（spec 的验证要求）**

```bash
# 应通过（200）：
#   "今天有点想家，希望这只瓶子替我去远方看看。"
#   "祝捡到瓶子的你天天开心！"
# 应拒绝（422）——用明显违规样本各测一条色情/暴力表述
```

若 Llama Guard 对中文违规样本放行 → 按 spec 回退方案改 `moderation.ts`：改调 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`，prompt 输出结构化判定（safe/unsafe），接口不变，测试不变。把结论记录到 README。

- [ ] **Step 6: [用户] 创建 GitHub 仓库与 Secrets**

```bash
git remote -v  # 确认无远端
gh repo create drift-bottle --public --source . --push
gh secret set CMEMS_USERNAME --body 'rmself@qq.com'
gh secret set CMEMS_PASSWORD  # 交互输入
gh secret set CLOUDFLARE_ACCOUNT_ID --body '<account id>'
gh secret set CLOUDFLARE_D1_DATABASE_ID --body '<database id>'
gh secret set CLOUDFLARE_API_TOKEN  # 用户在 dash.cloudflare.com 创建（权限: Account / D1 / Edit）
```

- [ ] **Step 7: 手动触发一次工作流验证**

```bash
gh workflow run daily-drift && sleep 60 && gh run list --workflow daily-drift --limit 1
gh run view --log  # 确认下载、推进、写回全部成功
```

Expected: run 成功；D1 里瓶子 `simulated_to` 更新到最新数据日、track_points 增加

- [ ] **Step 8: 提交收尾**

```bash
git add web/wrangler.toml && git commit -m "chore: 回填 D1 database_id" && git push
```

---

## 计划自审记录

- **Spec 覆盖**：产品规则（Task 6/7/8/9）、ID 三层安全模型（Task 2/6/7）、审核 fail-closed 与中文验证（Task 5/13-5）、海洋吸附与位图（Task 3/4）、模拟管线水位线/幂等/入队时机（Task 10/11：`simulated_to` 护栏即 spec「幂等」的实现细化，`launched_at` 当日不推进由「投瓶时 simulated_to=当日」保证）、6h 轨迹点（Task 10 snapshots / Task 11 写回）、GitHub Actions（Task 12）、部署与 E2E（Task 13）✓
- **类型一致性**：`OceanMask.isSafeCell/snapToOcean`、`moderate` 返回三值、`DayResult` 字段、`writeback_sql` 签名在测试与实现间已核对 ✓
- **两处 spec 细化**（非偏离）：① 掩码文件从 `web/assets/` 移至 `web/public/`（经 ASSETS binding 运行时加载，避免打包体积限制；掩码本身无秘密）；② schema 用 wrangler migrations 目录（`web/migrations/0001_init.sql`）替代单文件 `schema.sql`，以复用官方测试/部署工具链
