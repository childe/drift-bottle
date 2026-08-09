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
