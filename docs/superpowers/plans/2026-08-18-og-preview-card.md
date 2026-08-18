# OG 社交预览卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分享 `/b/{token}` 时显示一张带真实洋流轨迹 + 里程 + 天数的本地化社交预览卡。

**Architecture:** 每日 GitHub Actions 的 Python 任务对每个活跃瓶子渲染 1200×630 PNG 并经 S3 API 覆盖上传到 R2（key `og/{public_id}.png`）；Worker 的 `/b/{token}` 改为动态 HTML 注入 per-bottle `og:*` meta，`og:image` 指向 `/og/{public_id}.png`，该路由由 Worker 从 R2 廉价读取（缺失回退默认卡）。

**Tech Stack:** Python 3.12 + Pillow + numpy + boto3（模拟/渲染）；Cloudflare Workers + Hono + TypeScript + D1 + R2（Web）；vitest（@cloudflare/vitest-pool-workers）+ pytest。

## Global Constraints

- 语言允许值仅 `zh` / `en`，其它一律 `en`（含缺失）。
- 卡片画布固定 **1200×630**。
- 图 URL 与 R2 key 一律用 **public_id**，**绝不含 token**；卡片/meta 只含已公开信息（轨迹/里程/天数/状态/品牌语），绝不含信件正文。
- 预览卡相关逻辑**必须 fail-open**：`/b/{token}` 查不到或 DB 异常 → 回代纯 `track.html`；`/og/{pid}.png` R2 缺失/异常 → 回退 `og-default.png`；绝不因预览卡逻辑让页面/图 500，绝不影响现有投瓶/追踪/捡拾。
- 口径一致：里程取累计 `distance_km`（四舍五入到整数 km），天数取 `created_at` 至今（`floor`，非负）；两者都是瓶子终身累计。
- 文案：品牌 `漂流瓶`(zh)/`Drift Bottle`(en)；`og:description` 用品牌 slogan「写一封信，余下的交给洋流与命运。」/「Write a letter. Leave the rest to the currents.」。
- **v1 卡片 PNG 文案不含 emoji**（spec 已写明「渲染不稳则退化」；此处退化为纯文字，不用彩色 emoji 字体，避免 CI 渲染不确定）。
- R2 对象 key 格式：`og/{public_id}.png`（public_id 为 12 位 `[A-Za-z0-9]`）。
- Python 改动后用 black 格式化；TS 沿用现有风格。

---

### Task 1: bottles.lang 迁移 + 投瓶接口捕获语言 + 前端带上语言

**Files:**
- Create: `web/migrations/0002_bottle_lang.sql`
- Modify: `web/src/index.ts`（`POST /api/bottles` handler，约 38-70 行）
- Modify: `web/public/app.js:63`（投瓶请求体）
- Test: `web/test/api-drop-lang.test.ts`

**Interfaces:**
- Consumes: 现有 `POST /api/bottles`（收 `content/lat/lon`）、`OceanMask/setMask/GridSpec`（`src/ocean`）、`getLang()`（i18n.js 全局）。
- Produces: `bottles.lang` 列（`TEXT NOT NULL DEFAULT 'en'`）；投瓶时以 `lang` 字段写入（zh/en，非法回退 en）。后续 Task 2/3/4 依赖该列。

- [ ] **Step 1: 写迁移文件**

`web/migrations/0002_bottle_lang.sql`：
```sql
ALTER TABLE bottles ADD COLUMN lang TEXT NOT NULL DEFAULT 'en';
```

- [ ] **Step 2: 写失败测试**

`web/test/api-drop-lang.test.ts`：
```ts
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd web && npx vitest run test/api-drop-lang.test.ts`
Expected: FAIL —— 迁移未加 lang 列或未写入，`row.lang` 非预期（或 SQL 报错）。

- [ ] **Step 4: 改投瓶接口写入 lang**

`web/src/index.ts`，将 handler 开头的解构与 INSERT 改为：
```ts
app.post("/api/bottles", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { content, lat, lon } = body as Record<string, unknown>;
  const lang = (body as Record<string, unknown>).lang === "zh" ? "zh" : "en";
  const bad = await checkSubmission(c, content, lat, lon);
  if (bad) return bad;
```
并把第一条 INSERT 改为（增加 `lang` 列与占位符，bind 末尾加 `lang`）：
```ts
    c.env.DB.prepare(
      `INSERT INTO bottles (public_id, status, lat, lon, launched_at, simulated_to, distance_km, created_at, lang)
       VALUES (?, 'drifting', ?, ?, ?, ?, 0, ?, ?)`
    ).bind(publicId, snap.lat, snap.lon, t, day, t, lang),
```

- [ ] **Step 5: 前端投瓶带上当前语言**

`web/public/app.js:63`，请求体加 `lang: getLang()`：
```js
        body: JSON.stringify({ content, lat: userPos.lat, lon: userPos.lon, lang: getLang() }),
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd web && npx vitest run test/api-drop-lang.test.ts && npx vitest run`
Expected: 新测试全过；现有测试仍全过（迁移 0002 会被 `readD1Migrations` 自动纳入）。

- [ ] **Step 7: 提交**

```bash
git add web/migrations/0002_bottle_lang.sql web/src/index.ts web/public/app.js web/test/api-drop-lang.test.ts
git commit -m "feat(og): bottles.lang 迁移 + 投瓶记录语言"
```

---

### Task 2: Python 卡片渲染器 + 默认卡资产

**Files:**
- Create: `simulation/og_card.py`（渲染部分）
- Modify: `simulation/pyproject.toml`（加 `pillow>=10.1`）
- Create: `web/public/og-default.png`（由渲染器生成后提交）
- Test: `simulation/tests/test_og_card.py`

**Interfaces:**
- Consumes: `numpy`；掩码 bool 数组语义同 `ocean_snap.load_safe_mask()`（`True`=可投放海洋）。
- Produces（供 Task 3 调用）：
  - `render_card(track: list[tuple[float,float]], distance_km: float, days: int, status: str, lang: str, mask=None) -> bytes`（PNG）
  - `render_default_card() -> bytes`
  - 纯函数 `unwrap_lons(lons)`, `compute_view(lats, lons)`, `to_pixel(lon, lat, view)`, `stat_line(distance_km, days, status, lang)`, `brand_text(lang)`
  - 常量 `W=1200, H=630`

- [ ] **Step 1: 加依赖**

`simulation/pyproject.toml` 的 `dependencies` 增加一行：
```toml
  "pillow>=10.1",
```

- [ ] **Step 2: 写失败测试**

`simulation/tests/test_og_card.py`：
```python
import io

from PIL import Image

from og_card import (
    W, H, unwrap_lons, compute_view, to_pixel, stat_line, brand_text,
    render_card, render_default_card,
)


def test_stat_line_zh_drifting():
    assert stat_line(3200.4, 48, "drifting", "zh") == "漂了 3,200 公里 · 48 天 · 漂流中"


def test_stat_line_en_beached_singular_day():
    assert stat_line(1000, 1, "beached", "en") == "Drifted 1,000 km · 1 day · Beached"


def test_stat_line_en_plural_days():
    assert stat_line(2500, 12, "drifting", "en") == "Drifted 2,500 km · 12 days · Drifting"


def test_brand_text():
    assert brand_text("zh") == "漂流瓶"
    assert brand_text("en") == "Drift Bottle"


def test_unwrap_lons_crosses_antimeridian():
    assert unwrap_lons([179.0, -179.0]) == [179.0, 181.0]


def test_compute_view_non_degenerate_for_single_point():
    lon_min, lon_max, lat_min, lat_max = compute_view([10.0, 10.0], [20.0, 20.0])
    assert lon_max > lon_min and lat_max > lat_min


def test_to_pixel_top_left_and_bottom_right():
    view = (0.0, 10.0, 0.0, 10.0)  # lon_min,lon_max,lat_min,lat_max
    x0, y0 = to_pixel(0.0, 10.0, view)   # 左上
    x1, y1 = to_pixel(10.0, 0.0, view)   # 右下
    assert round(x0) == 0 and round(y0) == 0
    assert round(x1) == W and round(y1) == H


def test_render_card_returns_1200x630_png():
    png = render_card([(0.0, 0.0), (1.0, 1.0), (2.0, 3.0)], 3200, 48, "drifting", "zh")
    im = Image.open(io.BytesIO(png))
    assert im.format == "PNG" and im.size == (W, H)


def test_render_card_single_point():
    png = render_card([(10.0, 20.0)], 0, 0, "drifting", "en")
    assert Image.open(io.BytesIO(png)).size == (W, H)


def test_render_card_empty_track():
    png = render_card([], 0, 0, "beached", "en")
    assert Image.open(io.BytesIO(png)).size == (W, H)


def test_render_default_card():
    im = Image.open(io.BytesIO(render_default_card()))
    assert im.format == "PNG" and im.size == (W, H)
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd simulation && uv run pytest tests/test_og_card.py -v`
Expected: FAIL with "No module named 'og_card'"（或导入符号缺失）。

- [ ] **Step 4: 实现渲染器**

`simulation/og_card.py`：
```python
"""OG 社交预览卡渲染：把瓶子的真实洋流轨迹画成 1200x630 PNG。

纯渲染，无 IO 依赖（掩码由调用方传入）。v1 文案纯文字，不用 emoji。
掩码语义同 ocean_snap.load_safe_mask()：True=可投放海洋，False=陆地/近岸。
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630

# 掩码网格（与 ocean_snap 对齐）
LAT0, LON0 = -80.0, -180.0
DLAT = DLON = 1.0 / 12.0
NLAT, NLON = 2041, 4320

BG_TOP = (10, 42, 67)
BG_BOTTOM = (18, 80, 122)
LAND = (23, 57, 79)
TRACK_A = (79, 195, 247)   # 蓝（起点）
TRACK_B = (224, 64, 251)   # 品红（当前点）
WHITE = (240, 246, 250)

_FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]


def load_font(size: int):
    import os
    for p in _FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default(size)


def brand_text(lang: str) -> str:
    return "漂流瓶" if lang == "zh" else "Drift Bottle"


def stat_line(distance_km: float, days: int, status: str, lang: str) -> str:
    km = f"{round(distance_km):,}"
    if lang == "zh":
        state = "漂流中" if status == "drifting" else "搁浅"
        return f"漂了 {km} 公里 · {days} 天 · {state}"
    state = "Drifting" if status == "drifting" else "Beached"
    unit = "day" if days == 1 else "days"
    return f"Drifted {km} km · {days} {unit} · {state}"


def unwrap_lons(lons):
    """把跨 ±180 的经度序列展开成连续值，避免轨迹横跳整幅地图。"""
    if not lons:
        return []
    out = [float(lons[0])]
    for lon in lons[1:]:
        d = float(lon) - out[-1]
        while d > 180:
            d -= 360
        while d < -180:
            d += 360
        out.append(out[-1] + d)
    return out


def compute_view(lats, lons, pad_frac=0.15, min_span=5.0, aspect=W / H):
    """由轨迹算出等距圆柱视窗 (lon_min, lon_max, lat_min, lat_max)，
    含最小跨度兜底、留白、与画布宽高比校正（避免拉伸）。"""
    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)

    def _min(a, b, span):
        if b - a < span:
            c = (a + b) / 2.0
            return c - span / 2.0, c + span / 2.0
        return a, b

    lat_min, lat_max = _min(lat_min, lat_max, min_span)
    lon_min, lon_max = _min(lon_min, lon_max, min_span)

    lat_span = lat_max - lat_min
    lon_span = lon_max - lon_min
    lat_min -= lat_span * pad_frac
    lat_max += lat_span * pad_frac
    lon_min -= lon_span * pad_frac
    lon_max += lon_span * pad_frac

    lat_span = lat_max - lat_min
    lon_span = lon_max - lon_min
    if lon_span / lat_span < aspect:
        target = lat_span * aspect
        c = (lon_min + lon_max) / 2.0
        lon_min, lon_max = c - target / 2.0, c + target / 2.0
    else:
        target = lon_span / aspect
        c = (lat_min + lat_max) / 2.0
        lat_min, lat_max = c - target / 2.0, c + target / 2.0
    return (lon_min, lon_max, lat_min, lat_max)


def to_pixel(lon, lat, view, w=W, h=H):
    lon_min, lon_max, lat_min, lat_max = view
    x = (lon - lon_min) / (lon_max - lon_min) * w
    y = (lat_max - lat) / (lat_max - lat_min) * h
    return x, y


def _gradient(top, bottom):
    t = np.linspace(0, 1, H)
    grad = np.outer(1 - t, np.array(top)) + np.outer(t, np.array(bottom))
    return np.repeat(grad[:, None, :], W, axis=1).astype(np.uint8)


def _overlay_land(arr, view, mask):
    lon_min, lon_max, lat_min, lat_max = view
    xs = np.linspace(lon_min, lon_max, W)
    ys = np.linspace(lat_max, lat_min, H)
    iy = np.clip(np.round((ys - LAT0) / DLAT).astype(int), 0, NLAT - 1)
    ix = (np.round(((xs - LON0) % 360.0) / DLON).astype(int)) % NLON
    safe = mask[np.ix_(iy, ix)]
    arr[~safe] = LAND


def _draw_track(draw, pts):
    n = len(pts)
    if n == 1:
        x, y = pts[0]
        draw.ellipse([x - 10, y - 10, x + 10, y + 10], fill=TRACK_B)
        return
    for i in range(n - 1):
        t = i / (n - 2) if n > 2 else 0.0
        col = tuple(int(TRACK_A[k] + (TRACK_B[k] - TRACK_A[k]) * t) for k in range(3))
        draw.line([pts[i], pts[i + 1]], fill=col, width=6)
    sx, sy = pts[0]
    draw.ellipse([sx - 11, sy - 11, sx + 11, sy + 11], outline=TRACK_A, width=4)
    ex, ey = pts[-1]
    draw.ellipse([ex - 12, ey - 12, ex + 12, ey + 12], fill=TRACK_B)


def render_card(track, distance_km, days, status, lang, mask=None) -> bytes:
    arr = _gradient(BG_TOP, BG_BOTTOM)
    if track:
        lats = [p[0] for p in track]
        lons = unwrap_lons([p[1] for p in track])
        view = compute_view(lats, lons)
        if mask is not None:
            _overlay_land(arr, view, mask)
    img = Image.fromarray(arr, "RGB")
    draw = ImageDraw.Draw(img)
    if track:
        pts = [to_pixel(lo, la, view) for la, lo in zip(lats, lons)]
        _draw_track(draw, pts)
    draw.text((48, 40), brand_text(lang), font=load_font(46), fill=WHITE)
    line = stat_line(distance_km, days, status, lang)
    sf = load_font(40)
    draw.text((49, H - 76), line, font=sf, fill=(0, 0, 0))
    draw.text((48, H - 78), line, font=sf, fill=WHITE)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_default_card() -> bytes:
    img = Image.fromarray(_gradient(BG_TOP, BG_BOTTOM), "RGB")
    draw = ImageDraw.Draw(img)
    draw.text((48, 40), "漂流瓶 · Drift Bottle", font=load_font(46), fill=WHITE)
    slogan = "写一封信，余下的交给洋流与命运。"
    draw.text((48, H - 78), slogan, font=load_font(38), fill=WHITE)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
```

- [ ] **Step 5: 运行测试确认通过 + 格式化**

Run: `cd simulation && uv run pytest tests/test_og_card.py -v && uv run black og_card.py tests/test_og_card.py`
Expected: 全过。

- [ ] **Step 6: 生成默认卡资产**

Run:
```bash
cd simulation && uv run python -c "import og_card, pathlib; pathlib.Path('../web/public/og-default.png').write_bytes(og_card.render_default_card())"
```
校验：`test -f web/public/og-default.png`。

- [ ] **Step 7: 提交**

```bash
git add simulation/og_card.py simulation/pyproject.toml simulation/uv.lock simulation/tests/test_og_card.py web/public/og-default.png
git commit -m "feat(og): Python 卡片渲染器 + 默认兜底卡"
```

---

### Task 3: Python R2 上传 + 每日批量入口 + CI 接线

**Files:**
- Modify: `simulation/og_card.py`（追加数据读取、R2 上传、`main()`）
- Modify: `simulation/pyproject.toml`（加 `boto3>=1.34`）
- Modify: `.github/workflows/daily-drift.yml`（新增渲染步骤）
- Test: `simulation/tests/test_og_card_main.py`

**Interfaces:**
- Consumes: `render_card`（Task 2）、`D1Client`（`d1.py`）、`load_safe_mask`（`ocean_snap.py`）。
- Produces：
  - `fetch_active_bottles(d1) -> list[dict]`
  - `fetch_track(d1, bottle_id) -> list[tuple[float,float]]`
  - `days_since(created_at: str, today: date) -> int`
  - `make_r2_client()`、`upload_card(s3, bucket, public_id, png)`
  - `render_and_upload_all(d1, s3, bucket, mask, today) -> int`（返回成功数；逐瓶 try/except 隔离）
  - `main()`

- [ ] **Step 1: 加依赖**

`simulation/pyproject.toml` 的 `dependencies` 增加：
```toml
  "boto3>=1.34",
```

- [ ] **Step 2: 写失败测试**

`simulation/tests/test_og_card_main.py`：
```python
from datetime import date

import og_card


class FakeD1:
    def __init__(self, bottles, tracks):
        self.bottles = bottles
        self.tracks = tracks

    def query(self, sql, params=None):
        if "FROM bottles" in sql:
            return self.bottles
        if "track_points" in sql:
            return self.tracks.get(params[0], [])
        return []


class FakeS3:
    def __init__(self):
        self.puts = []

    def put_object(self, **kw):
        self.puts.append(kw)


def _bottle(id, pid, status="drifting", dist=100, created="2026-08-01", lang="en"):
    return {"id": id, "public_id": pid, "status": status,
            "distance_km": dist, "created_at": created, "lang": lang}


def test_days_since():
    assert og_card.days_since("2026-08-01T00:00:00Z", date(2026, 8, 18)) == 17


def test_uploads_each_bottle_with_correct_key():
    bottles = [_bottle(1, "aaaaaaaaaaaa", lang="zh"), _bottle(2, "bbbbbbbbbbbb", "beached")]
    tracks = {1: [{"lat": 0, "lon": 0}, {"lat": 1, "lon": 1}], 2: [{"lat": 5, "lon": 5}]}
    s3 = FakeS3()
    n = og_card.render_and_upload_all(FakeD1(bottles, tracks), s3, "bk", None, date(2026, 8, 18))
    assert n == 2
    assert sorted(k["Key"] for k in s3.puts) == ["og/aaaaaaaaaaaa.png", "og/bbbbbbbbbbbb.png"]
    assert all(k["ContentType"] == "image/png" for k in s3.puts)
    assert all(k["Bucket"] == "bk" for k in s3.puts)


def test_one_bottle_failure_does_not_abort_batch():
    bottles = [_bottle(1, "good11111111"), _bottle(2, "bad222222222", created="NOT-A-DATE")]
    tracks = {1: [{"lat": 0, "lon": 0}], 2: [{"lat": 0, "lon": 0}]}
    s3 = FakeS3()
    n = og_card.render_and_upload_all(FakeD1(bottles, tracks), s3, "bk", None, date(2026, 8, 18))
    assert n == 1
    assert [k["Key"] for k in s3.puts] == ["og/good11111111.png"]
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd simulation && uv run pytest tests/test_og_card_main.py -v`
Expected: FAIL —— `render_and_upload_all` / `days_since` 未定义。

- [ ] **Step 4: 实现数据读取 + 上传 + 入口**

在 `simulation/og_card.py` 末尾追加：
```python
import os
from datetime import date, datetime, timezone

from d1 import D1Client
from ocean_snap import load_safe_mask


def fetch_active_bottles(d1):
    return d1.query(
        "SELECT id, public_id, status, distance_km, created_at, lang "
        "FROM bottles WHERE status IN ('drifting','beached')"
    )


def fetch_track(d1, bottle_id):
    rows = d1.query(
        "SELECT lat, lon FROM track_points WHERE bottle_id = ? ORDER BY ts ASC",
        [bottle_id],
    )
    return [(float(r["lat"]), float(r["lon"])) for r in rows]


def days_since(created_at, today):
    d0 = date.fromisoformat(created_at[:10])
    return max(0, (today - d0).days)


def make_r2_client():
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", region_name="auto"),
    )


def upload_card(s3, bucket, public_id, png):
    s3.put_object(Bucket=bucket, Key=f"og/{public_id}.png", Body=png, ContentType="image/png")


def render_and_upload_all(d1, s3, bucket, mask, today) -> int:
    bottles = fetch_active_bottles(d1)
    ok = 0
    for b in bottles:
        try:
            track = fetch_track(d1, int(b["id"]))
            days = days_since(b["created_at"], today)
            png = render_card(track, float(b["distance_km"]), days, b["status"], b["lang"], mask)
            upload_card(s3, bucket, b["public_id"], png)
            ok += 1
        except Exception as e:  # 单瓶失败不拖垮整批
            print(f"[og_card] 瓶 {b.get('public_id')} 渲染/上传失败: {e}")
    print(f"[og_card] 完成 {ok}/{len(bottles)}")
    return ok


def main():
    d1 = D1Client(
        os.environ["CLOUDFLARE_ACCOUNT_ID"],
        os.environ["CLOUDFLARE_D1_DATABASE_ID"],
        os.environ["CLOUDFLARE_API_TOKEN"],
    )
    s3 = make_r2_client()
    bucket = os.environ["R2_BUCKET"]
    mask = load_safe_mask()
    today = datetime.now(timezone.utc).date()
    render_and_upload_all(d1, s3, bucket, mask, today)


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: 运行测试确认通过 + 格式化**

Run: `cd simulation && uv run pytest tests/test_og_card_main.py -v && uv run pytest && uv run black og_card.py tests/test_og_card_main.py`
Expected: 新测试过；整个 simulation 测试套件仍全过。

- [ ] **Step 6: CI 接线**

`.github/workflows/daily-drift.yml`，在「推进瓶子」步骤之后新增：
```yaml
      - name: 生成 OG 预览卡
        working-directory: simulation
        run: |
          sudo apt-get update && sudo apt-get install -y fonts-noto-cjk
          uv run python og_card.py
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_D1_DATABASE_ID: ${{ secrets.CLOUDFLARE_D1_DATABASE_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          R2_ENDPOINT: ${{ secrets.R2_ENDPOINT }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
```

- [ ] **Step 7: 提交**

```bash
git add simulation/og_card.py simulation/pyproject.toml simulation/uv.lock simulation/tests/test_og_card_main.py .github/workflows/daily-drift.yml
git commit -m "feat(og): 每日渲染批量上传 R2 + CI 接线"
```

---

### Task 4: og.ts 元信息构建 + /b/{token} 动态注入

**Files:**
- Create: `web/src/og.ts`
- Modify: `web/src/index.ts`（`/b/*` 路由，约 181-182 行；顶部 import）
- Test: `web/test/og-meta.test.ts`（纯函数）、`web/test/b-route.test.ts`（集成）

**Interfaces:**
- Consumes: `bottles.lang`（Task 1）、`ASSETS`（现有绑定）、`tokens`/`bottles` 表。
- Produces（供 index.ts 调用）：
  - `interface CardMeta { origin; publicId; lang: "zh"|"en"; days; distanceKm; status; canonicalUrl; dayStamp }`
  - `escapeAttr(s): string`、`ogTitle(m): string`、`ogDescription(m): string`、`ogMetaTags(m): string`、`injectHead(html, tags): string`

- [ ] **Step 1: 写纯函数失败测试**

`web/test/og-meta.test.ts`：
```ts
import { describe, it, expect } from "vitest";
import { escapeAttr, ogTitle, ogDescription, ogMetaTags, injectHead, CardMeta } from "../src/og";

const base: CardMeta = {
  origin: "https://driftbottle.love",
  publicId: "abcABC123456",
  lang: "zh",
  days: 48,
  distanceKm: 3200.4,
  status: "drifting",
  canonicalUrl: "https://driftbottle.love/b/TOKEN",
  dayStamp: "20260818",
};

describe("og-meta", () => {
  it("escapeAttr 转义引号与尖括号", () => {
    expect(escapeAttr(`a"<>&`)).toBe("a&quot;&lt;&gt;&amp;");
  });
  it("ogTitle 本地化", () => {
    expect(ogTitle(base)).toBe("一只漂流了 48 天的瓶子 · 漂流瓶");
    expect(ogTitle({ ...base, lang: "en" })).toBe("A bottle adrift for 48 days · Drift Bottle");
    expect(ogTitle({ ...base, lang: "en", days: 1 })).toBe("A bottle adrift for 1 day · Drift Bottle");
  });
  it("ogDescription 千分位 + slogan", () => {
    expect(ogDescription(base)).toBe("跟随真实洋流已漂 3,200 公里。写一封信，余下的交给洋流与命运。");
    expect(ogDescription({ ...base, lang: "en" })).toBe(
      "Carried 3,200 km by real ocean currents. Write a letter. Leave the rest to the currents."
    );
  });
  it("ogMetaTags 含带 public_id 与 dayStamp 的 og:image、summary_large_image", () => {
    const tags = ogMetaTags(base);
    expect(tags).toContain('property="og:image" content="https://driftbottle.love/og/abcABC123456.png?d=20260818"');
    expect(tags).toContain('name="twitter:card" content="summary_large_image"');
    expect(tags).toContain('property="og:image:width" content="1200"');
  });
  it("injectHead 插到 </head> 前", () => {
    const out = injectHead("<head><title>t</title></head><body>x</body>", "<meta>");
    expect(out).toBe("<head><title>t</title><meta>\n</head><body>x</body>");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd web && npx vitest run test/og-meta.test.ts`
Expected: FAIL —— `../src/og` 不存在。

- [ ] **Step 3: 实现 og.ts**

`web/src/og.ts`：
```ts
export type Lang = "zh" | "en";

export interface CardMeta {
  origin: string;
  publicId: string;
  lang: Lang;
  days: number;
  distanceKm: number;
  status: string;
  canonicalUrl: string;
  dayStamp: string; // YYYYMMDD
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function thousands(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function ogTitle(m: CardMeta): string {
  if (m.lang === "zh") return `一只漂流了 ${m.days} 天的瓶子 · 漂流瓶`;
  return `A bottle adrift for ${m.days} ${m.days === 1 ? "day" : "days"} · Drift Bottle`;
}

export function ogDescription(m: CardMeta): string {
  const km = thousands(m.distanceKm);
  if (m.lang === "zh") return `跟随真实洋流已漂 ${km} 公里。写一封信，余下的交给洋流与命运。`;
  return `Carried ${km} km by real ocean currents. Write a letter. Leave the rest to the currents.`;
}

export function ogMetaTags(m: CardMeta): string {
  const image = escapeAttr(`${m.origin}/og/${m.publicId}.png?d=${m.dayStamp}`);
  const title = escapeAttr(ogTitle(m));
  const desc = escapeAttr(ogDescription(m));
  const url = escapeAttr(m.canonicalUrl);
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${desc}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${desc}">`,
    `<meta name="twitter:image" content="${image}">`,
  ].join("\n");
}

export function injectHead(html: string, tags: string): string {
  return html.replace("</head>", `${tags}\n</head>`);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd web && npx vitest run test/og-meta.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 /b 集成失败测试**

`web/test/b-route.test.ts`：
```ts
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
```

- [ ] **Step 6: 运行确认失败**

Run: `cd web && npx vitest run test/b-route.test.ts`
Expected: FAIL —— 现有 `/b/*` 只回代静态页，未注入 `/og/...`。

- [ ] **Step 7: 改 /b 路由为动态注入**

`web/src/index.ts` 顶部 import 增加：
```ts
import { ogMetaTags, injectHead } from "./og";
```
把第 181-182 行的 `/b/*` 路由替换为：
```ts
// 追踪页：/b/<token> 动态注入 per-bottle OG 预览卡 meta；查不到/异常回代纯页面（fail-open）
app.get("/b/*", async (c) => {
  const plain = () => c.env.ASSETS.fetch(new Request(new URL("/track.html", c.req.url)));
  const token = c.req.path.replace(/^\/b\//, "").split("/")[0];
  if (!token) return plain();
  let row: Record<string, unknown> | null = null;
  try {
    row = await c.env.DB.prepare(
      `SELECT b.public_id AS publicId, b.status, b.distance_km AS distanceKm,
              b.created_at AS createdAt, b.lang AS lang
       FROM tokens t JOIN bottles b ON b.id = t.bottle_id WHERE t.token = ?`
    ).bind(token).first();
  } catch {
    row = null;
  }
  if (!row) return plain();
  const html = await (await plain()).text();
  const origin = new URL(c.req.url).origin;
  const days = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(String(row.createdAt))) / 86400000)
  );
  const dayStamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const tags = ogMetaTags({
    origin,
    publicId: String(row.publicId),
    lang: row.lang === "zh" ? "zh" : "en",
    days,
    distanceKm: Number(row.distanceKm) || 0,
    status: String(row.status),
    canonicalUrl: `${origin}/b/${token}`,
    dayStamp,
  });
  return c.html(injectHead(html, tags));
});
```

- [ ] **Step 8: 运行确认通过**

Run: `cd web && npx vitest run test/b-route.test.ts test/og-meta.test.ts && npx vitest run`
Expected: 新测试过；全套仍过。

- [ ] **Step 9: 提交**

```bash
git add web/src/og.ts web/src/index.ts web/test/og-meta.test.ts web/test/b-route.test.ts
git commit -m "feat(og): /b/{token} 动态注入本地化 OG meta"
```

---

### Task 5: /og/{pid}.png 路由 + OG(R2) 绑定 + wrangler 配置

**Files:**
- Modify: `web/src/index.ts`（`Env` 类型；新增 `/og/:file` 路由）
- Modify: `web/wrangler.toml`（`[[r2_buckets]]` 绑定；`run_worker_first` 加 `/og/*`）
- Modify: `web/test/env.d.ts`（加 `OG` 绑定类型）
- Test: `web/test/og-route.test.ts`

**Interfaces:**
- Consumes: R2 对象 `og/{public_id}.png`（Task 3 上传）、`og-default.png`（Task 2 生成）、`ASSETS`。
- Produces: `Env.OG: R2Bucket`；`GET /og/:file` 返回 PNG 或默认卡。

- [ ] **Step 1: 写失败测试**

`web/test/og-route.test.ts`：
```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd web && npx vitest run test/og-route.test.ts`
Expected: FAIL —— 路由不存在/`OG` 未定义。

- [ ] **Step 3: 加 OG 绑定类型**

`web/src/index.ts` 第 8 行 `Env` 改为：
```ts
export type Env = { DB: D1Database; AI: Ai; ASSETS: Fetcher; OG: R2Bucket };
```
`web/test/env.d.ts` 的 `interface Env` 增加一行：
```ts
    OG: R2Bucket;
```

- [ ] **Step 4: 实现 /og 路由**

`web/src/index.ts`，在 `/b/*` 路由之后、`export default app;` 之前插入：
```ts
// OG 图：从 R2 读 og/{public_id}.png，缺失/异常回退默认卡（fail-open）
app.get("/og/:file", async (c) => {
  const fallback = () => c.env.ASSETS.fetch(new Request(new URL("/og-default.png", c.req.url)));
  const m = c.req.param("file").match(/^([A-Za-z0-9]{12})\.png$/);
  if (!m) return fallback();
  let obj: R2ObjectBody | null = null;
  try {
    obj = await c.env.OG.get(`og/${m[1]}.png`);
  } catch {
    obj = null;
  }
  if (!obj) return fallback();
  return new Response(obj.body, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" },
  });
});
```

- [ ] **Step 5: wrangler 绑定 + 路由**

`web/wrangler.toml`：`run_worker_first` 改为含 `/og/*`：
```toml
run_worker_first = ["/api/*", "/b/*", "/og/*"]
```
并在文件末尾追加 R2 绑定：
```toml
[[r2_buckets]]
binding = "OG"
bucket_name = "drift-bottle-og"
```

- [ ] **Step 6: 运行确认通过（全套）**

Run: `cd web && npx vitest run`
Expected: 全部通过（含 og-route、b-route、og-meta、api-drop-lang 及原有）。

- [ ] **Step 7: 提交**

```bash
git add web/src/index.ts web/wrangler.toml web/test/env.d.ts web/test/og-route.test.ts
git commit -m "feat(og): /og/{pid}.png 路由 + R2 绑定"
```

---

## Deployment & Verification（实现全部完成、评审通过后由控制方执行，非编码任务）

1. 远端应用 D1 迁移：`cd web && npx wrangler d1 migrations apply drift-bottle --remote`。
2. 部署 Worker：`cd web && npm run deploy`。
3. 手动触发一次每日任务生成卡片：`gh workflow run daily-drift.yml`；跑完确认 R2 有 `og/*.png`（`npx wrangler r2 object get drift-bottle-og/og/<某public_id>.png --file /tmp/x.png` 或看 CI 日志 `[og_card] 完成 N/N`）。
4. 端到端验证：投一只新瓶 → 打开 `/b/{token}` 查看源码含 `og:image`（分享前用 https://cards-dev.twitter.com/validator 或各平台调试器抓取）；新瓶未渲染时 `/og/{pid}.png` 应回默认卡，次日渲染后应回真实轨迹卡。
5. 用 `Closes #3` 开 PR，评审合并。

## Self-Review

- **Spec coverage**：
  - §1 lang → Task 1 ✓；§2 投瓶捕获 → Task 1 ✓；§3 R2 存储 → Task 3(上传)+Task 5(绑定) ✓；§4 每日渲染 → Task 2(渲染)+Task 3(批量/上传/CI) ✓；§5 卡片视觉 → Task 2 ✓（emoji 按 Global Constraints 退化为纯文字）；§6 /b 动态 → Task 4 ✓；§7 /og 路由 → Task 5 ✓；§8 默认卡 → Task 2 ✓；隐私边界（public_id、无 token/正文、转义）→ Task 4/5 ✓；错误降级 → Task 3/4/5 fail-open ✓；测试策略 → 各任务 TDD ✓；部署前置 → Deployment 节 ✓。
- **Placeholder scan**：无 TBD/TODO；每个代码步骤含完整可粘贴代码与测试。
- **Type consistency**：`render_card(track, distance_km, days, status, lang, mask=None)` 在 Task 2 定义、Task 3 调用签名一致；`CardMeta` 字段在 og.ts 定义与 index.ts 构造一致；`OG: R2Bucket` 在 src/index.ts 与 test/env.d.ts 一致；R2 key `og/{public_id}.png` 在 Task 3 上传与 Task 5 读取一致；`day` 口径（created_at）在 Python `days_since` 与 TS `/b` 计算一致。
