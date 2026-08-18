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
TRACK_A = (79, 195, 247)  # 蓝（起点）
TRACK_B = (224, 64, 251)  # 品红（当前点）
WHITE = (240, 246, 250)

_FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
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
    s3.put_object(
        Bucket=bucket, Key=f"og/{public_id}.png", Body=png, ContentType="image/png"
    )


def render_and_upload_all(d1, s3, bucket, mask, today) -> int:
    bottles = fetch_active_bottles(d1)
    ok = 0
    for b in bottles:
        try:
            track = fetch_track(d1, int(b["id"]))
            days = days_since(b["created_at"], today)
            png = render_card(
                track, float(b["distance_km"]), days, b["status"], b["lang"], mask
            )
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
