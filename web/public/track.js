const map = L.map("map").setView([25, 140], 3);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap",
}).addTo(map);

const token = location.pathname.replace(/\/$/, "").split("/").pop();
const info = document.getElementById("info");
let cached = null; // 缓存 track 数据，语言切换时重渲染而不重复请求

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function renderInfoAndLetters(d) {
  const L_ = getLang();
  const days = Math.max(0, (Date.now() - Date.parse(d.created_at)) / 86400e3);
  let statusText;
  if (d.status === "beached") {
    const n = redriftDaysLeft(d.beached_at, Date.now());
    statusText = n > 0 ? tf("status_beached", L_, { n }) : t("status_beached_soon", L_);
  } else {
    statusText = t("status_drifting", L_);
  }
  info.innerHTML = `
    <p>${tf("track_status", L_, { s: statusText })}<br>
    ${tf("track_start", L_, { date: escapeHtml(d.created_at.slice(0, 10)), days: days.toFixed(0) })}<br>
    ${tf("track_distance", L_, { km: Math.round(d.distance_km) })}</p>`;
  document.getElementById("letters").innerHTML =
    `<h3>${tf("track_letters_title", L_, { n: d.messages.length })}</h3>` +
    d.messages.map((m) => `<div class="letter">${escapeHtml(m.content)}
      <div class="meta">${escapeHtml(m.created_at.slice(0, 10))}</div></div>`).join("");
}

function drawMap(d) {
  const pts = d.track.map((p) => [p.lat, p.lon]);
  if (pts.length > 1) {
    for (let i = 1; i < pts.length; i++) {
      const hue = 210 + (130 * i) / pts.length;
      L.polyline([pts[i - 1], pts[i]], { color: `hsl(${hue},85%,45%)`, weight: 3, opacity: 0.9 }).addTo(map);
    }
  }
  if (pts.length) {
    L.circleMarker(pts[0], { radius: 7, color: "#fff", fillColor: "#1668dc", fillOpacity: 1, weight: 2 })
      .addTo(map).bindPopup(t("popup_start", getLang()));
    const endText = d.status === "beached" ? t("popup_beached_here", getLang()) : t("popup_here", getLang());
    L.marker([d.position.lat, d.position.lon]).addTo(map).bindPopup(endText).openPopup();
    const allPts = [...pts, [d.position.lat, d.position.lon]];
    const uniq = new Set(allPts.map((p) => p.join(",")));
    if (uniq.size === 1) map.setView(allPts[0], 5);
    else map.fitBounds(L.latLngBounds(allPts).pad(0.2));
  }
}

(async () => {
  try {
    const res = await fetch(`/api/track/${token}`);
    if (!res.ok) { info.innerHTML = `<p class="error">${t("track_not_found", getLang())}</p>`; return; }
    cached = await res.json();
    renderInfoAndLetters(cached);
    drawMap(cached); // 地图标记只画一次（切换语言仅重渲染文字面板）
  } catch {
    info.innerHTML = `<p class="error">${t("track_not_found", getLang())}</p>`;
  }
})();

// 语言切换：重渲染文字面板（地图已画，不重复）
window.addEventListener("i18n:changed", () => { if (cached) renderInfoAndLetters(cached); });
