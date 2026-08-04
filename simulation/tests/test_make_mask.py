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
