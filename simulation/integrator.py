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
    step_km: np.ndarray  # 当日漂流里程
    beached_hour: np.ndarray  # -1 未搁浅；否则 0-23
    snapshots: list  # [(hour, lats, lons)] hour ∈ {6,12,18,24}


def _haversine_km(lat1, lon1, lat2, lon2):
    rad = np.pi / 180
    dlat = (lat2 - lat1) * rad
    dlon = (lon2 - lon1) * rad
    a = (
        np.sin(dlat / 2) ** 2
        + np.cos(lat1 * rad) * np.cos(lat2 * rad) * np.sin(dlon / 2) ** 2
    )
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
