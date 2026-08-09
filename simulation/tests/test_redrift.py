from datetime import datetime, timezone
from unittest.mock import patch

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


def test_refloat_skips_when_snap_returns_none():
    mask = load_safe_mask()
    now = datetime(2026, 8, 9, tzinfo=timezone.utc)
    d1 = FakeD1([{"id": 3, "lat": 31.0, "lon": 122.0}])
    with patch("advance.snap_to_safe", return_value=None):
        n = refloat_beached(d1, now, mask)
    assert n == 0
    assert not any(s.strip().startswith("UPDATE") for s in d1.executed)
