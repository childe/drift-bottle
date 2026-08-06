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
        {
            "uo": (("time", "latitude", "longitude"), u),
            "vo": (("time", "latitude", "longitude"), v),
        },
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
    # 向西 1.0 m/s，从 lon=1.5（干净的 [1,2] 格）出发，
    # 约第 15 小时进入 lon=0 陆地列的含 NaN 插值格 → 搁浅
    field = CurrentField(synthetic_ds(u_val=-1.0))
    r = advance_day(field, date(2026, 8, 1), np.array([10.0]), np.array([1.5]))
    assert r.beached_hour[0] > 5  # 确实漂了一段才搁浅
    assert r.lons[0] > 1.0  # 停在最后一个海上位置，不进陆地


def test_velocity_time_interp_and_clamp():
    ds = synthetic_ds()
    ds["uo"].values[1, :, :] = 1.0  # 第二天流速翻倍
    field = CurrentField(ds)
    day1_noon = np.datetime64("2026-08-01T12:00").astype("datetime64[s]").astype(float)
    day2_noon = np.datetime64("2026-08-02T12:00").astype("datetime64[s]").astype(float)
    u_mid, _ = field.velocity(
        (day1_noon + day2_noon) / 2, np.array([10.0]), np.array([10.0])
    )
    assert abs(u_mid[0] - 0.75) < 0.01  # 两天中点 → 线性插值
    u_before, _ = field.velocity(day1_noon - 86400, np.array([10.0]), np.array([10.0]))
    assert abs(u_before[0] - 0.5) < 0.01  # 范围外截断到端点
