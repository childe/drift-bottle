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
