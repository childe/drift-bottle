"""漂流瓶原型：拉取 CMEMS SMOC 表层流场 -> 模拟漂移 -> 生成 HTML 轨迹图。

用法:
    python drift_prototype.py            # 三步全跑（已有数据文件则跳过下载）
"""

import json
import math
import pathlib
import sys

import numpy as np
import xarray as xr

HERE = pathlib.Path(__file__).parent
NC_FILE = HERE / "currents_east_china_sea.nc"
HTML_FILE = HERE / "trajectory.html"

# ---- 配置 ----
# 日均环流(uo/vo)。生产环境建议换逐小时 SMOC: cmems_mod_glo_phy_anfc_merged-uv_PT1H-i
DATASET_ID = "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m"
VARS = ["uo", "vo"]
# 区域: 东海 -> 日本以东，给黑潮留足空间
LON_MIN, LON_MAX = 118.0, 148.0
LAT_MIN, LAT_MAX = 20.0, 42.0
T_START, T_END = "2026-06-29", "2026-07-30"
# 投放点: 上海外海（东海陆架，黑潮西侧）
DROP_LON, DROP_LAT = 123.5, 30.5
DT_SECONDS = 3600  # 积分步长 1 小时


def fetch():
    if NC_FILE.exists():
        print(f"[fetch] 已存在 {NC_FILE.name}，跳过下载")
        return
    import copernicusmarine

    copernicusmarine.subset(
        dataset_id=DATASET_ID,
        variables=VARS,
        minimum_longitude=LON_MIN,
        maximum_longitude=LON_MAX,
        minimum_latitude=LAT_MIN,
        maximum_latitude=LAT_MAX,
        start_datetime=T_START,
        end_datetime=T_END,
        minimum_depth=0,
        maximum_depth=1,  # 只要表层，否则会下 50 层深度共 1GB+
        output_filename=str(NC_FILE),
    )
    print(f"[fetch] 下载完成: {NC_FILE.name}")


class CurrentField:
    """对日均流场做空间双线性 + 时间线性插值。陆地(NaN)返回 None。"""

    def __init__(self, ds):
        if "depth" in ds.dims:
            ds = ds.isel(depth=0)  # 只取表层
        ds = ds.squeeze(drop=True)
        self.lon = ds.longitude.values
        self.lat = ds.latitude.values
        self.t = ds.time.values.astype("datetime64[s]").astype(float)
        self.u = ds[VARS[0]].values  # (time, lat, lon)
        self.v = ds[VARS[1]].values

    def _interp(self, arr, ti, wt, lat, lon):
        ix = np.searchsorted(self.lon, lon) - 1
        iy = np.searchsorted(self.lat, lat) - 1
        if not (0 <= ix < len(self.lon) - 1 and 0 <= iy < len(self.lat) - 1):
            return None
        wx = (lon - self.lon[ix]) / (self.lon[ix + 1] - self.lon[ix])
        wy = (lat - self.lat[iy]) / (self.lat[iy + 1] - self.lat[iy])
        out = 0.0
        for dt_, w_t in ((0, 1 - wt), (1, wt)):
            sub = arr[ti + dt_, iy : iy + 2, ix : ix + 2]
            if np.isnan(sub).any():
                return None  # 贴岸格点，视为搁浅
            out += w_t * (
                sub[0, 0] * (1 - wx) * (1 - wy)
                + sub[0, 1] * wx * (1 - wy)
                + sub[1, 0] * (1 - wx) * wy
                + sub[1, 1] * wx * wy
            )
        return out

    def velocity(self, t_sec, lat, lon):
        if not (self.t[0] <= t_sec <= self.t[-1]):
            return None
        ti = min(np.searchsorted(self.t, t_sec) - 1, len(self.t) - 2)
        ti = max(ti, 0)
        wt = (t_sec - self.t[ti]) / (self.t[ti + 1] - self.t[ti])
        u = self._interp(self.u, ti, wt, lat, lon)
        v = self._interp(self.v, ti, wt, lat, lon)
        if u is None or v is None:
            return None
        return u, v


def step_rk2(field, t, lat, lon, dt):
    """Heun 二阶积分一步。返回新位置，或 None 表示搁浅。"""
    vel1 = field.velocity(t, lat, lon)
    if vel1 is None:
        return None
    m_per_deg = 111320.0
    lat1 = lat + vel1[1] * dt / m_per_deg
    lon1 = lon + vel1[0] * dt / (m_per_deg * math.cos(math.radians(lat)))
    vel2 = field.velocity(t + dt, lat1, lon1)
    if vel2 is None:
        vel2 = vel1  # 中点上岸则退化为一阶
    u, v = (vel1[0] + vel2[0]) / 2, (vel1[1] + vel2[1]) / 2
    new_lat = lat + v * dt / m_per_deg
    new_lon = lon + u * dt / (m_per_deg * math.cos(math.radians(lat)))
    return new_lat, new_lon


def simulate():
    ds = xr.open_dataset(NC_FILE)
    field = CurrentField(ds)
    t, lat, lon = field.t[0], DROP_LAT, DROP_LON
    track = [(float(t), lat, lon)]
    beached = False
    while t + DT_SECONDS <= field.t[-1]:
        pos = step_rk2(field, t, lat, lon, DT_SECONDS)
        if pos is None:
            beached = True
            break
        lat, lon = pos
        t += DT_SECONDS
        track.append((float(t), lat, lon))
    days = (track[-1][0] - track[0][0]) / 86400
    dist = sum(
        math.dist(
            (a[1] * 111.32, a[2] * 111.32 * math.cos(math.radians(a[1]))),
            (b[1] * 111.32, b[2] * 111.32 * math.cos(math.radians(a[1]))),
        )
        for a, b in zip(track, track[1:])
    )
    print(
        f"[simulate] 漂了 {days:.1f} 天, 总里程 {dist:.0f} km, "
        f"终点 ({track[-1][1]:.2f}N, {track[-1][2]:.2f}E)"
        + (" —— 搁浅上岸!" if beached else "")
    )
    return track, beached


def render_html(track, beached):
    # 每 3 小时取一个点，减小 HTML 体积
    pts = [
        {"t": t, "lat": round(la, 4), "lon": round(lo, 4)}
        for t, la, lo in track[:: max(1, 3600 * 3 // DT_SECONDS)]
    ]
    if pts[-1]["t"] != track[-1][0]:
        t, la, lo = track[-1]
        pts.append({"t": t, "lat": round(la, 4), "lon": round(lo, 4)})
    data = json.dumps({"points": pts, "beached": beached}, ensure_ascii=False)
    html = TEMPLATE.replace("__DATA__", data)
    HTML_FILE.write_text(html, encoding="utf-8")
    print(f"[render] 已生成 {HTML_FILE}")


TEMPLATE = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>漂流瓶轨迹</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html, body, #map { height: 100%; margin: 0; }
  #panel {
    position: absolute; top: 12px; right: 12px; z-index: 1000;
    background: rgba(255,255,255,.94); padding: 12px 16px; border-radius: 10px;
    font: 14px/1.6 -apple-system, "PingFang SC", sans-serif;
    box-shadow: 0 2px 10px rgba(0,0,0,.2); min-width: 210px;
  }
  #panel b { font-size: 15px; }
  #playBtn { width: 100%; margin-top: 8px; padding: 6px; border: 0;
    border-radius: 6px; background: #1668dc; color: #fff; cursor: pointer; }
  #playBtn:hover { background: #0f57bd; }
</style>
</head>
<body>
<div id="map"></div>
<div id="panel">
  <b>🍾 漂流瓶轨迹</b><br>
  <span id="info">加载中…</span>
  <button id="playBtn">▶ 播放漂流动画</button>
</div>
<script>
const DATA = __DATA__;
const pts = DATA.points;
const latlngs = pts.map(p => [p.lat, p.lon]);
const map = L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { attribution: '&copy; OpenStreetMap' }).addTo(map);
map.fitBounds(L.latLngBounds(latlngs).pad(0.15));

// 轨迹按时间渐变着色
for (let i = 1; i < latlngs.length; i++) {
  const hue = 210 + 130 * i / latlngs.length;   // 蓝 -> 品红
  L.polyline([latlngs[i-1], latlngs[i]],
    { color: `hsl(${hue},85%,45%)`, weight: 3, opacity: .9 }).addTo(map);
}
const fmt = t => new Date(t * 1000).toISOString().slice(0, 10);
L.circleMarker(latlngs[0], { radius: 7, color: '#fff', fillColor: '#1668dc',
  fillOpacity: 1, weight: 2 }).addTo(map).bindPopup('投放点 ' + fmt(pts[0].t));
const endIcon = DATA.beached ? '🏝️ 搁浅' : '🌊 仍在漂流';
L.circleMarker(latlngs.at(-1), { radius: 7, color: '#fff', fillColor: '#d4380d',
  fillOpacity: 1, weight: 2 }).addTo(map)
  .bindPopup(endIcon + ' ' + fmt(pts.at(-1).t)).openPopup();

const days = (pts.at(-1).t - pts[0].t) / 86400;
document.getElementById('info').innerHTML =
  `投放: ${fmt(pts[0].t)}<br>历时: ${days.toFixed(1)} 天<br>状态: ${endIcon}`;

// 动画
const bottle = L.marker(latlngs[0], { icon: L.divIcon({ html: '🍾',
  className: '', iconSize: [24, 24] }) }).addTo(map);
let timer = null;
document.getElementById('playBtn').onclick = () => {
  if (timer) { clearInterval(timer); timer = null; return; }
  let i = 0;
  timer = setInterval(() => {
    bottle.setLatLng(latlngs[i]);
    bottle.bindTooltip(fmt(pts[i].t), { permanent: true, direction: 'top' });
    if (++i >= latlngs.length) { clearInterval(timer); timer = null; }
  }, 40);
};
</script>
</body>
</html>
"""


if __name__ == "__main__":
    if "--no-fetch" not in sys.argv:
        fetch()
    track, beached = simulate()
    render_html(track, beached)
