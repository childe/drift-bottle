from datetime import date

import numpy as np

from advance import run, writeback_sql
from currents import CurrentField
from tests.test_integrator import synthetic_ds


class FakeD1:
    def __init__(self, bottles):
        self.bottles = bottles
        self.executed = []

    def query(self, sql, params=None):
        self.executed.append(sql)
        if sql.strip().startswith("SELECT"):
            return self.bottles
        return []


def bottle(id_, lat, lon, simulated_to, dist=0.0):
    return {
        "id": id_,
        "lat": lat,
        "lon": lon,
        "distance_km": dist,
        "simulated_to": simulated_to,
    }


def test_advances_eligible_bottle_and_writes_watermark():
    field = CurrentField(synthetic_ds(days=("2026-08-01", "2026-08-02")))
    d1 = FakeD1([bottle(1, 10.0, 10.0, "2026-07-31")])
    run(d1, field)
    writes = [s for s in d1.executed if "UPDATE bottles" in s]
    assert len(writes) == 2  # 两个可模拟日各一次写回
    assert "simulated_to < '2026-08-01'" in writes[0]
    assert "sim_watermark" in writes[0]
    assert "INSERT OR IGNORE INTO track_points" in writes[0]


def test_skips_already_simulated_days():
    field = CurrentField(synthetic_ds(days=("2026-08-01", "2026-08-02")))
    d1 = FakeD1([bottle(1, 10.0, 10.0, "2026-08-02")])  # 已模拟到最新
    run(d1, field)
    assert not any("UPDATE bottles" in s for s in d1.executed)


def test_beached_bottle_written_with_status():
    field = CurrentField(synthetic_ds(u_val=-1.0, days=("2026-08-01",)))
    d1 = FakeD1(
        [bottle(1, 10.0, 1.5, "2026-07-31")]
    )  # 向西必搁浅（lon=1.5，约15h进NaN列）
    run(d1, field)
    w = next(s for s in d1.executed if "UPDATE bottles" in s)
    assert "status='beached'" in w
    assert "beached_at=" in w


def test_writeback_sql_is_deterministic():
    field = CurrentField(synthetic_ds(days=("2026-08-01",)))
    from integrator import advance_day

    b = [bottle(7, 10.0, 10.0, "2026-07-31")]
    r = advance_day(field, date(2026, 8, 1), np.array([10.0]), np.array([10.0]))
    sql = writeback_sql(date(2026, 8, 1), b, r)
    assert "WHERE id = 7 AND simulated_to < '2026-08-01'" in sql
    assert sql.count("INSERT OR IGNORE INTO track_points") == 1  # 单语句多 VALUES
    assert "(7, '2026-08-01T06:00:00Z'" in sql
