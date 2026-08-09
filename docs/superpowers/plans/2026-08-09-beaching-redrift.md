# 搁浅—重漂机制实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 瓶子撞岸后暂时搁浅 7 天（可被捡），无人捡则自动吸附回开阔海格重新漂流，无上限循环——让瓶子更可能漂远、搁浅不再速死。

**Architecture:** Python 侧新增 `ocean_snap.py`（加载投瓶同款离岸掩码 + 螺旋吸附），`advance.py` 每日任务开头先重漂满 7 天的搁浅瓶再照常推进；前端据 API 已返回的 `beached_at` 自算「N 天后重漂」倒计时。后端 API 与 D1 schema 不变。规格见 `docs/superpowers/specs/2026-08-08-beaching-redrift-design.md`。

**Tech Stack:** Python 3.12（uv）、numpy、pytest；vanilla JS + node --test（i18n 纯函数）

## Global Constraints

- `REDRIFT_DAYS = 7`；**无逃逸上限**（不存在"永久搁浅"态，瓶子只有 drifting/beached）
- GLO12 网格：`lat0=-80, lon0=-180, dLat=dLon=1/12, nLat=2041, nLon=4320`；掩码位序 `idx=iy*4320+ix`，`np.unpackbits` big 位序
- 掩码文件：`web/public/ocean-mask.bin`（2041×4320 bool，Task4 已生成入库）；`advance.py` 从 `simulation/` 运行，相对路径 `../web/public/ocean-mask.bin`
- 时刻格式统一 `Z` 结尾 `%Y-%m-%dT%H:%M:%SZ`（`beached_at`/`launched_at`/`cutoff` 都用它，保证 ISO 字符串字典序 = 时间序）
- 累计里程 `distance_km` **不清零**；搁浅→重漂的吸附跳跃**不计入**里程
- `refloat_beached` 必须在 `main()` "没有 drifting 瓶就退出"检查**之前**调用
- 后端 `web/src/index.ts` 与 D1 schema **不改**
- Python 改完 `uv run black .`；测试 `cd simulation && uv run pytest`
- 前端 `i18n.js` 浏览器全局 + Node CommonJS 双兼容，**无裸 export/import**；改完 `node --check`
- 提交信息末尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Python 端海洋吸附（ocean_snap.py）

**Files:**
- Create: `simulation/ocean_snap.py`
- Test: `simulation/tests/test_ocean_snap.py`

**Interfaces:**
- Produces:
  - `LAT0=-80.0, LON0=-180.0, DLAT=DLON=1/12, NLAT=2041, NLON=4320`, `MASK_PATH`
  - `load_safe_mask(path=MASK_PATH) -> np.ndarray`（bool (NLAT,NLON)）
  - `snap_to_safe(mask, lat, lon, lat0=LAT0, lon0=LON0, dlat=DLAT, dlon=DLON) -> tuple[float,float] | None`（所在格安全→原地返回；否则螺旋找最近安全格中心；全陆→None）

- [ ] **Step 1: 写失败测试**

`simulation/tests/test_ocean_snap.py`：

```python
import numpy as np

from ocean_snap import snap_to_safe, load_safe_mask


def _mask_right_half():
    # 8x8：ix>=4 为安全海，ix<4 为陆
    m = np.zeros((8, 8), bool)
    m[:, 4:] = True
    return m


def test_open_point_stays_in_place():
    m = _mask_right_half()
    r = snap_to_safe(m, 3.5, 6.0, lat0=0, lon0=0, dlat=1, dlon=1)
    assert r == (3.5, 6.0)  # 所在格安全，原地返回


def test_land_point_snaps_to_sea():
    m = _mask_right_half()
    r = snap_to_safe(m, 3.0, 1.0, lat0=0, lon0=0, dlat=1, dlon=1)  # 陆地
    assert r is not None
    lat, lon = r
    assert lon >= 4.0  # 吸附到海侧列


def test_all_land_returns_none():
    m = np.zeros((8, 8), bool)
    assert snap_to_safe(m, 3, 3, lat0=0, lon0=0, dlat=1, dlon=1) is None


def test_longitude_wraps():
    # ix=0 陆、ix=7 海；点在 ix=0 处，最近安全格经环绕可达 ix=7
    m = np.zeros((5, 8), bool)
    m[:, 7] = True
    r = snap_to_safe(m, 2.0, 0.0, lat0=0, lon0=0, dlat=1, dlon=1)
    assert r is not None


def test_real_mask_shape_and_known_cells():
    m = load_safe_mask()
    assert m.shape == (2041, 4320) and m.dtype == bool

    def cell(lat, lon):
        iy = round((lat + 80) / (1 / 12))
        ix = round(((lon + 180) % 360) / (1 / 12)) % 4320
        return bool(m[iy, ix])

    assert cell(0, -140) is True   # 太平洋中部：安全
    assert cell(46, 90) is False   # 亚洲内陆：非安全
```

- [ ] **Step 2: 运行确认失败**

Run: `cd simulation && uv run pytest tests/test_ocean_snap.py -v`
Expected: FAIL（ocean_snap 不存在）

- [ ] **Step 3: 实现 ocean_snap.py**

```python
"""重漂吸附：把搁浅点吸附到最近的开阔安全海格。

复用投瓶同款掩码 web/public/ocean-mask.bin（3x3 腐蚀，离岸≥1格）。
逻辑对齐 web/src/ocean.ts 的 snapToOcean：所在格安全则原地返回；
否则按切比雪夫环外扩、命中后再看 2 圈取 haversine 最近。
"""

from __future__ import annotations

import pathlib
from math import asin, cos, radians, sin, sqrt

import numpy as np

LAT0, LON0 = -80.0, -180.0
DLAT = DLON = 1.0 / 12.0
NLAT, NLON = 2041, 4320
MASK_PATH = pathlib.Path(__file__).parent.parent / "web" / "public" / "ocean-mask.bin"


def load_safe_mask(path=MASK_PATH) -> np.ndarray:
    bits = np.fromfile(str(path), dtype=np.uint8)
    flat = np.unpackbits(bits)[: NLAT * NLON]
    return flat.reshape(NLAT, NLON).astype(bool)


def _is_safe(mask, iy, ix) -> bool:
    nlat, nlon = mask.shape
    if iy < 0 or iy >= nlat:
        return False
    return bool(mask[iy, ix % nlon])


def _ring(iy0, ix0, r):
    if r == 0:
        yield iy0, ix0
        return
    for dx in range(-r, r + 1):
        yield iy0 - r, ix0 + dx
        yield iy0 + r, ix0 + dx
    for dy in range(-r + 1, r):
        yield iy0 + dy, ix0 - r
        yield iy0 + dy, ix0 + r


def _hav_km(a1, o1, a2, o2):
    dl = radians(a2 - a1)
    do = radians(o2 - o1)
    h = sin(dl / 2) ** 2 + cos(radians(a1)) * cos(radians(a2)) * sin(do / 2) ** 2
    return 2 * 6371.0 * asin(sqrt(h))


def snap_to_safe(mask, lat, lon, lat0=LAT0, lon0=LON0, dlat=DLAT, dlon=DLON):
    nlat, nlon = mask.shape
    iy0 = min(nlat - 1, max(0, round((lat - lat0) / dlat)))
    ix0 = round((((lon - lon0) % 360.0)) / dlon) % nlon
    if _is_safe(mask, iy0, ix0):
        return lat, lon
    max_ring = max(nlat, nlon)
    best = None
    found_ring = -1
    for r in range(max_ring + 1):
        if found_ring >= 0 and r > found_ring + 2:
            break
        for iy, ix in _ring(iy0, ix0, r):
            if not _is_safe(mask, iy, ix):
                continue
            ixw = ix % nlon
            clat = lat0 + iy * dlat
            clon = lon0 + ixw * dlon
            d = _hav_km(lat, lon, clat, clon)
            if best is None or d < best[2]:
                best = (clat, clon, d)
            if found_ring < 0:
                found_ring = r
    return None if best is None else (best[0], best[1])
```

- [ ] **Step 4: 运行确认通过，black，提交**

Run: `cd simulation && uv run pytest tests/test_ocean_snap.py -v && uv run black .`
Expected: 5 个测试全 PASS

```bash
git add simulation/ocean_snap.py simulation/tests/test_ocean_snap.py
git commit -m "feat(simulation): 重漂海洋吸附 ocean_snap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 每日重漂逻辑（advance.py）

**Files:**
- Modify: `simulation/advance.py`（加 `REDRIFT_DAYS` 常量 + `refloat_beached` 函数 + `main()` 集成）
- Test: `simulation/tests/test_redrift.py`

**Interfaces:**
- Consumes: `load_safe_mask`、`snap_to_safe`（Task 1）
- Produces: `advance.REDRIFT_DAYS = 7`；`advance.refloat_beached(d1, now: datetime, mask) -> int`（重漂满 7 天的搁浅瓶，返回重漂数量）

- [ ] **Step 1: 写失败测试**

`simulation/tests/test_redrift.py`：

```python
from datetime import datetime, timezone

from advance import refloat_beached, REDRIFT_DAYS
from ocean_snap import load_safe_mask


class FakeD1:
    def __init__(self, select_rows):
        self.select_rows = select_rows
        self.executed = []

    def query(self, sql, params=None):
        self.executed.append(sql)
        if sql.strip().startswith("SELECT"):
            return self.select_rows
        return []


def test_redrift_days_is_7():
    assert REDRIFT_DAYS == 7


def test_refloat_generates_drift_update_with_cutoff():
    mask = load_safe_mask()
    now = datetime(2026, 8, 9, 12, 0, 0, tzinfo=timezone.utc)
    d1 = FakeD1([{"id": 1, "lat": 31.0, "lon": 122.0}])
    n = refloat_beached(d1, now, mask)
    assert n == 1
    sel = d1.executed[0]
    assert "status='beached'" in sel
    # cutoff = now - 7 天，Z 结尾格式
    assert "beached_at <= '2026-08-02T12:00:00Z'" in sel
    upd = d1.executed[1]
    assert "status='drifting'" in upd
    assert "beached_at=NULL" in upd
    assert "launched_at='2026-08-09T00:00:00Z'" in upd
    assert "simulated_to='2026-08-09'" in upd
    assert "WHERE id=1 AND status='beached'" in upd


def test_refloat_snaps_to_safe_cell():
    mask = load_safe_mask()
    now = datetime(2026, 8, 9, tzinfo=timezone.utc)
    # 取一个内陆点，重漂后坐标必须落在安全海格
    d1 = FakeD1([{"id": 2, "lat": 46.0, "lon": 90.0}])
    refloat_beached(d1, now, mask)
    upd = d1.executed[1]
    # 从 UPDATE 里解析 lat/lon，断言在 mask 上安全
    import re

    lat = float(re.search(r"lat=([-\d.]+)", upd).group(1))
    lon = float(re.search(r"lon=([-\d.]+)", upd).group(1))
    iy = round((lat + 80) / (1 / 12))
    ix = round(((lon + 180) % 360) / (1 / 12)) % 4320
    assert bool(mask[iy, ix]) is True


def test_refloat_none_when_no_beached():
    mask = load_safe_mask()
    d1 = FakeD1([])  # SELECT 无满足条件的搁浅瓶
    n = refloat_beached(d1, datetime(2026, 8, 9, tzinfo=timezone.utc), mask)
    assert n == 0
    assert not any(s.strip().startswith("UPDATE") for s in d1.executed)
```

- [ ] **Step 2: 运行确认失败**

Run: `cd simulation && uv run pytest tests/test_redrift.py -v`
Expected: FAIL（refloat_beached / REDRIFT_DAYS 不存在）

- [ ] **Step 3: 在 advance.py 加常量与 refloat_beached**

在 `advance.py` 顶部 imports 之后加：

```python
from ocean_snap import load_safe_mask, snap_to_safe

REDRIFT_DAYS = 7
```

在 `run()` 之前（或 `main()` 之前任意模块级位置）加函数：

```python
def refloat_beached(d1, now: datetime, mask) -> int:
    """把搁浅满 REDRIFT_DAYS 天的瓶子吸附回开阔海格，重新 drifting。返回重漂数量。

    时刻统一 Z 结尾，保证 ISO 字符串字典序=时间序。吸附跳跃不计入里程。
    """
    cutoff = (now - timedelta(days=REDRIFT_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    today = now.date().isoformat()
    rows = d1.query(
        "SELECT id, lat, lon FROM bottles "
        "WHERE status='beached' AND beached_at IS NOT NULL "
        f"AND beached_at <= '{cutoff}'"
    )
    if not rows:
        return 0
    stmts = []
    for b in rows:
        snapped = snap_to_safe(mask, float(b["lat"]), float(b["lon"]))
        if snapped is None:
            continue  # 理论上不会：全球总能找到海格
        slat, slon = snapped
        stmts.append(
            f"UPDATE bottles SET status='drifting', beached_at=NULL, "
            f"lat={slat:.5f}, lon={slon:.5f}, "
            f"launched_at='{today}T00:00:00Z', simulated_to='{today}' "
            f"WHERE id={int(b['id'])} AND status='beached'"
        )
    if stmts:
        d1.query(";\n".join(stmts))
    return len(stmts)
```

- [ ] **Step 4: 在 main() 最开头集成（早于"无 drifting 瓶退出"检查）**

把 `main()` 改成（重漂在 MIN 查询**之前**；重漂需要 mask 与 now）：

```python
def main() -> None:
    d1 = D1Client(
        os.environ["CLOUDFLARE_ACCOUNT_ID"],
        os.environ["CLOUDFLARE_D1_DATABASE_ID"],
        os.environ["CLOUDFLARE_API_TOKEN"],
    )
    now = datetime.now(timezone.utc)
    mask = load_safe_mask()
    refloated = refloat_beached(d1, now, mask)
    if refloated:
        print(f"[advance] 重漂 {refloated} 只搁浅满 {REDRIFT_DAYS} 天的瓶子")

    rows = d1.query(
        "SELECT MIN(simulated_to) AS m FROM bottles WHERE status = 'drifting'"
    )
    if not rows or rows[0]["m"] is None:
        print("[advance] 没有漂流中的瓶子，退出")
        return
    start = date.fromisoformat(rows[0]["m"]) + timedelta(days=1)
    end = now.date()
    if start > end:
        print("[advance] 已是最新，退出")
        return
    if DATA.exists():
        DATA.unlink()
    download_currents(start, end, DATA)
    import xarray as xr

    field = CurrentField(xr.open_dataset(DATA))
    run(d1, field)
```

- [ ] **Step 5: 运行全部 simulation 测试确认通过，black，提交**

Run: `cd simulation && uv run pytest -v && uv run black .`
Expected: 全部 PASS（含既有测试与 Task 1、Task 2 新测试）

```bash
git add simulation/advance.py simulation/tests/test_redrift.py
git commit -m "feat(simulation): 每日重漂搁浅满7天的瓶子

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 前端重漂倒计时展示（i18n + 首页 + 追踪页）

**Files:**
- Modify: `web/public/i18n.js`（+`REDRIFT_DAYS`、`redriftDaysLeft`、改 `status_beached`、+`status_beached_soon`、+倒计时 key）
- Modify: `web/test/i18n.node.test.cjs`（加 `redriftDaysLeft` 与字典完整性测试）
- Modify: `web/public/track.js`（搁浅瓶显示倒计时）
- Modify: `web/public/app.js`（附近搁浅瓶显示倒计时）

**Interfaces:**
- Consumes: `t`/`tf`/`getLang`（既有）；API 已返回的 `beached_at`
- Produces: `i18n.js` 新增 `REDRIFT_DAYS=7`、`redriftDaysLeft(beachedAtIso, nowMs): number`（CommonJS 导出）

- [ ] **Step 1: 写失败测试（i18n 纯函数）**

在 `web/test/i18n.node.test.cjs` 末尾（`require` 解构处补上新导出）追加：

先把文件顶部的解构改为包含新导出：`const { t, tf, tError, resolveLang, SUPPORTED, I18N, redriftDaysLeft, REDRIFT_DAYS } = ...`（sandbox 求值方式不变，只是多解构两个名字）。

追加测试：

```js
test("REDRIFT_DAYS 为 7", () => {
  assert.strictEqual(REDRIFT_DAYS, 7);
});

test("redriftDaysLeft: 刚搁浅=7, 满7天=0, 超过=0, 3.5天=4", () => {
  const t0 = Date.parse("2026-08-01T00:00:00Z");
  assert.strictEqual(redriftDaysLeft("2026-08-01T00:00:00Z", t0), 7);
  assert.strictEqual(redriftDaysLeft("2026-08-01T00:00:00Z", t0 + 7 * 86400000), 0);
  assert.strictEqual(redriftDaysLeft("2026-08-01T00:00:00Z", t0 + 9 * 86400000), 0);
  assert.strictEqual(redriftDaysLeft("2026-08-01T00:00:00Z", t0 + 3.5 * 86400000), 4);
});

test("新增 status_beached_soon / redrift_soon 有 zh/en", () => {
  for (const k of ["status_beached_soon", "redrift_countdown", "redrift_soon"]) {
    assert.ok(I18N.zh[k] !== undefined && I18N.en[k] !== undefined, k);
  }
});
```

（既有的 "每个 zh key 都有对应 en key" 完整性测试会自动覆盖改动后的字典。）

- [ ] **Step 2: 运行确认失败**

Run: `cd web && node --test test/i18n.node.test.cjs`
Expected: FAIL（redriftDaysLeft/REDRIFT_DAYS 未导出、新 key 不存在）

- [ ] **Step 3: 改 i18n.js**

字典里 `status_beached` 改为带占位符，并新增 4 个 key（zh 与 en 各加）：

```js
// zh 字典中：
status_beached: "🏝️ 已搁浅，{n} 天后随潮水再漂",
status_beached_soon: "🏝️ 即将随潮水再漂",
redrift_countdown: "· {n} 天后再漂",
redrift_soon: "· 即将再漂",
// en 字典中：
status_beached: "🏝️ Beached, re-drifts in {n} days",
status_beached_soon: "🏝️ Beached, about to re-drift",
redrift_countdown: "· re-drifts in {n}d",
redrift_soon: "· re-drifting soon",
```

在纯函数区（`resolveLang` 附近）加常量与函数：

```js
const REDRIFT_DAYS = 7;

function redriftDaysLeft(beachedAtIso, nowMs) {
  const elapsed = (nowMs - Date.parse(beachedAtIso)) / 86400000;
  return Math.max(0, Math.ceil(REDRIFT_DAYS - elapsed));
}
```

在文件末尾 CommonJS 尾巴的导出对象里加上 `REDRIFT_DAYS, redriftDaysLeft`：

```js
if (typeof module !== "undefined" && module.exports) {
  module.exports = { I18N, t, tf, tError, resolveLang, SUPPORTED, REDRIFT_DAYS, redriftDaysLeft };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd web && node --test test/i18n.node.test.cjs`
Expected: 全部 PASS

- [ ] **Step 5: 改 track.js（搁浅状态带倒计时）**

在 `renderInfoAndLetters(d)` 里，把 `statusText` 的计算改为：

```js
let statusText;
if (d.status === "beached") {
  const n = redriftDaysLeft(d.beached_at, Date.now());
  statusText = n > 0 ? tf("status_beached", L_, { n }) : t("status_beached_soon", L_);
} else {
  statusText = t("status_drifting", L_);
}
```

（其余不变；`L_` 是该函数已有的 `getLang()` 局部变量。）

- [ ] **Step 6: 改 app.js（附近搁浅瓶列表项加倒计时）**

在 `loadNearby()` 的列表项模板里，`nearby_item` 之后追加倒计时片段：

```js
item.innerHTML = `${tf("nearby_item", getLang(), { days: b.days_at_sea, km: Math.round(b.distance_km) })}
  ${(() => {
    const n = redriftDaysLeft(b.beached_at, Date.now());
    return n > 0 ? tf("redrift_countdown", getLang(), { n }) : t("redrift_soon", getLang());
  })()}
  <button class="secondary" style="margin-top:6px">${t("read_pick_btn", getLang())}</button>`;
```

（`b.beached_at` 由 `/api/nearby` 返回；nearby 只列搁浅瓶，故必有值。）

- [ ] **Step 7: 语法检查并提交**

Run: `cd web && node --check public/i18n.js && node --check public/track.js && node --check public/app.js`
Expected: 三个都无输出（语法 OK）

```bash
git add web/public/i18n.js web/public/track.js web/public/app.js web/test/i18n.node.test.cjs
git commit -m "feat(i18n): 搁浅瓶显示 N 天后重漂倒计时

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 计划自审记录

- **Spec 覆盖**：状态模型两态/无永久搁浅（§2 → 全计划无"永久搁浅"逻辑）；核心循环+7天+无上限（§3 → REDRIFT_DAYS + refloat 无次数上限）；每日重漂在退出检查前（§4 → Task 2 Step 4）；Python 吸附复用掩码（§5 → Task 1）；捡瓶不变（§6 → 无改动）；前端倒计时+i18n（§7 → Task 3）；测试（§8 → Task 1/2/3 单测）；后端/schema 不改（§10 → 无相关任务）✓
- **占位符扫描**：无 TBD/TODO；每步含完整代码；字典/SQL/测试全量给出 ✓
- **类型一致性**：`load_safe_mask`/`snap_to_safe`（Task1）被 Task2 消费签名一致；`refloat_beached(d1, now, mask)->int`、`REDRIFT_DAYS`（Task2）与测试一致；`redriftDaysLeft(beachedAtIso, nowMs)`、`REDRIFT_DAYS`（Task3 i18n）与测试及 track.js/app.js 调用一致；时刻格式 `%Y-%m-%dT%H:%M:%SZ` 与既有 `beached_at`（advance.py writeback `{d}T{HH}:00:00Z`）格式一致 ✓
- **部署（全部完成后）**：`cd web && wrangler deploy`（前端）；`simulation` 无需部署（GitHub Actions 每日跑，下次运行即生效）。冒烟：手动把一只测试瓶 `beached_at` 改成 8 天前 + `status='beached'`，`gh workflow run daily-drift` 后确认它变回 drifting 且坐标离岸有缓冲；前端强刷看搁浅瓶倒计时
- **一处取舍复述**：无上限 → 数据库瓶子只增不减（spec §9 backlog，本计划不处理）
