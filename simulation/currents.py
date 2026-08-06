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
        # 保存 time 坐标，squeeze(drop=True) 会丢弃标量时间坐标
        _times_raw = ds.time.values if "time" in ds.coords else None
        ds = ds.squeeze(drop=True)
        lon = ds.longitude.values.astype(float)
        self.lat = ds.latitude.values.astype(float)
        u = ds.uo.values
        v = ds.vo.values
        if u.ndim == 2:  # 单天文件无 time 维
            u, v = u[None], v[None]
            times = np.atleast_1d(ds.time.values if "time" in ds.coords else _times_raw)
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

    def _interp_2d(
        self, arr2d: np.ndarray, lats: np.ndarray, lons: np.ndarray
    ) -> np.ndarray:
        # 模运算归一化到 [lon[0], lon[0]+360)，任意越界均可修正
        lons = (lons - self.lon[0]) % 360.0 + self.lon[0]
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
        ti = int(
            np.clip(np.searchsorted(self.t, t_sec) - 1, 0, max(len(self.t) - 2, 0))
        )
        if len(self.t) == 1:
            return self._interp_2d(self.u[0], lats, lons), self._interp_2d(
                self.v[0], lats, lons
            )
        wt = (t_sec - self.t[ti]) / (self.t[ti + 1] - self.t[ti])
        u = (1 - wt) * self._interp_2d(self.u[ti], lats, lons) + wt * self._interp_2d(
            self.u[ti + 1], lats, lons
        )
        v = (1 - wt) * self._interp_2d(self.v[ti], lats, lons) + wt * self._interp_2d(
            self.v[ti + 1], lats, lons
        )
        return u, v
