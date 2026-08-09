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

    assert cell(0, -140) is True  # 太平洋中部：安全
    assert cell(46, 90) is False  # 亚洲内陆：非安全
