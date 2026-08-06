const map = L.map("map").setView([25, 140], 3);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap",
}).addTo(map);

const token = location.pathname.replace(/\/$/, "").split("/").pop();
const info = document.getElementById("info");

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

(async () => {
  const res = await fetch(`/api/track/${token}`);
  if (!res.ok) { info.innerHTML = `<p class="error">没有找到这只瓶子。链接是否完整？</p>`; return; }
  const d = await res.json();

  const days = Math.max(0, (Date.now() - Date.parse(d.created_at)) / 86400e3);
  info.innerHTML = `
    <p>状态：${d.status === "beached" ? "🏝️ 已搁浅，等待有缘人" : "🌊 正在漂流"}<br>
    启程：${escapeHtml(d.created_at.slice(0, 10))}（${days.toFixed(0)} 天前）<br>
    里程：${Math.round(d.distance_km)} km</p>`;

  const pts = d.track.map((p) => [p.lat, p.lon]);
  if (pts.length > 1) {
    for (let i = 1; i < pts.length; i++) {
      const hue = 210 + (130 * i) / pts.length;
      L.polyline([pts[i - 1], pts[i]], { color: `hsl(${hue},85%,45%)`, weight: 3, opacity: 0.9 }).addTo(map);
    }
  }
  if (pts.length) {
    L.circleMarker(pts[0], { radius: 7, color: "#fff", fillColor: "#1668dc", fillOpacity: 1, weight: 2 })
      .addTo(map).bindPopup("入海点");
    const endIcon = d.status === "beached" ? "🏝️ 搁浅于此" : "🌊 目前在这里";
    L.marker([d.position.lat, d.position.lon]).addTo(map).bindPopup(endIcon).openPopup();
    const allPts = [...pts, [d.position.lat, d.position.lon]];
    const uniq = new Set(allPts.map((p) => p.join(",")));
    if (uniq.size === 1) {
      map.setView(allPts[0], 5);
    } else {
      map.fitBounds(L.latLngBounds(allPts).pad(0.2));
    }
  }

  document.getElementById("letters").innerHTML =
    `<h3>瓶中信（${d.messages.length} 封）</h3>` +
    d.messages.map((m) => `<div class="letter">${escapeHtml(m.content)}
      <div class="meta">${escapeHtml(m.created_at.slice(0, 10))}</div></div>`).join("");
})();
