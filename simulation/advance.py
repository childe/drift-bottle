"""每日漂流任务：拉流场 → 推进 drifting 瓶子 → 写回 D1。

幂等：UPDATE 带 simulated_to < '当日' 护栏；track_points 用 INSERT OR IGNORE。
数值均为服务端生成（非用户输入），可安全拼入 SQL 字面量。
"""

from __future__ import annotations

import os
import pathlib
from datetime import date, timedelta, timezone, datetime

import numpy as np

from currents import CurrentField, download_currents
from d1 import D1Client
from integrator import DayResult, advance_day
from ocean_snap import load_safe_mask, snap_to_safe

DATA = pathlib.Path(__file__).parent / "currents_global.nc"

REDRIFT_DAYS = 7


def refloat_beached(d1, now: datetime, mask) -> int:
    """把搁浅满 REDRIFT_DAYS 天的瓶子吸附回开阔海格，重新 drifting。返回重漂数量。

    时刻统一 Z 结尾，保证 ISO 字符串字典序=时间序。吸附跳跃不计入里程。
    """
    cutoff = (now - timedelta(days=REDRIFT_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    today = now.date().isoformat()
    rows = d1.query(
        "SELECT id, lat, lon FROM bottles "
        "WHERE status='beached' AND beached_at IS NOT NULL "
        f"AND beached_at <= '{cutoff}'"
    )
    if not rows:
        return 0
    stmts = []
    for b in rows:
        snapped = snap_to_safe(mask, float(b["lat"]), float(b["lon"]))
        if snapped is None:
            continue  # 理论上不会：全球总能找到海格
        slat, slon = snapped
        stmts.append(
            f"UPDATE bottles SET status='drifting', beached_at=NULL, "
            f"lat={slat:.5f}, lon={slon:.5f}, "
            f"launched_at='{today}T00:00:00Z', simulated_to='{today}' "
            f"WHERE id={int(b['id'])} AND status='beached'"
        )
    if stmts:
        d1.query(";\n".join(stmts))
    return len(stmts)


def writeback_sql(day: date, bottles: list[dict], result: DayResult) -> str:
    """一天的全量写回：每瓶一条守卫 UPDATE + 轨迹批量 INSERT + 水位线。"""
    d = day.isoformat()
    stmts = []
    track_values = []
    for i, b in enumerate(bottles):
        lat, lon = float(result.lats[i]), float(result.lons[i])
        dist = float(b["distance_km"]) + float(result.step_km[i])
        if result.beached_hour[i] >= 0:
            beached_ts = f"{d}T{int(result.beached_hour[i]):02d}:00:00Z"
            status = f"status='beached', beached_at='{beached_ts}'"
        else:
            status = "status='drifting'"
        stmts.append(
            f"UPDATE bottles SET {status}, lat={lat:.5f}, lon={lon:.5f}, "
            f"distance_km={dist:.2f}, simulated_to='{d}' "
            f"WHERE id = {int(b['id'])} AND simulated_to < '{d}'"
        )
        for hour, slats, slons in result.snapshots:
            if result.beached_hour[i] >= 0 and hour > result.beached_hour[i] + 1:
                continue  # 搁浅后的快照不再记录
            ts = (
                f"{d}T{hour:02d}:00:00Z"
                if hour < 24
                else f"{(day + timedelta(days=1)).isoformat()}T00:00:00Z"
            )
            track_values.append(
                f"({int(b['id'])}, '{ts}', {float(slats[i]):.5f}, {float(slons[i]):.5f})"
            )
    if track_values:
        stmts.append(
            "INSERT OR IGNORE INTO track_points (bottle_id, ts, lat, lon) VALUES "
            + ", ".join(track_values)
        )
    stmts.append(
        f"INSERT INTO meta (key, value) VALUES ('sim_watermark', '{d}') "
        f"ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    return ";\n".join(stmts)


def run(d1, field) -> None:
    bottles = d1.query(
        "SELECT id, lat, lon, distance_km, simulated_to FROM bottles WHERE status = 'drifting'"
    )
    if not bottles:
        print("[advance] 没有漂流中的瓶子")
        return
    for day in field.available_days():
        d = day.isoformat()
        todo = [b for b in bottles if b["simulated_to"] < d]
        if not todo:
            continue
        lats = np.array([b["lat"] for b in bottles], dtype=float)
        lons = np.array([b["lon"] for b in bottles], dtype=float)
        idx = [i for i, b in enumerate(bottles) if b["simulated_to"] < d]
        result = advance_day(field, day, lats[idx], lons[idx])
        d1.query(writeback_sql(day, todo, result))
        beached = int((result.beached_hour >= 0).sum())
        print(f"[advance] {d}: 推进 {len(todo)} 只, 新搁浅 {beached} 只")
        # 更新内存状态供下一天继续
        for j, b in enumerate(todo):
            b["lat"], b["lon"] = float(result.lats[j]), float(result.lons[j])
            b["distance_km"] = float(b["distance_km"]) + float(result.step_km[j])
            b["simulated_to"] = d
            if result.beached_hour[j] >= 0:
                b["simulated_to"] = "9999-12-31"  # 已搁浅，后续天不再入 todo
    print("[advance] 完成")


def main() -> None:
    d1 = D1Client(
        os.environ["CLOUDFLARE_ACCOUNT_ID"],
        os.environ["CLOUDFLARE_D1_DATABASE_ID"],
        os.environ["CLOUDFLARE_API_TOKEN"],
    )
    now = datetime.now(timezone.utc)
    mask = load_safe_mask()
    refloated = refloat_beached(d1, now, mask)
    if refloated:
        print(f"[advance] 重漂 {refloated} 只搁浅满 {REDRIFT_DAYS} 天的瓶子")

    rows = d1.query(
        "SELECT MIN(simulated_to) AS m FROM bottles WHERE status = 'drifting'"
    )
    if not rows or rows[0]["m"] is None:
        print("[advance] 没有漂流中的瓶子，退出")
        return
    start = date.fromisoformat(rows[0]["m"]) + timedelta(days=1)
    end = now.date()
    if start > end:
        print("[advance] 已是最新，退出")
        return
    if DATA.exists():
        DATA.unlink()
    download_currents(start, end, DATA)
    import xarray as xr

    field = CurrentField(xr.open_dataset(DATA))
    run(d1, field)


if __name__ == "__main__":
    main()
