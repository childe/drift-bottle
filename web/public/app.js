const map = L.map("map").setView([25, 140], 3);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap",
}).addTo(map);

let userPos = null;
let userMarker = null;
let userPosLabelKey = null; // 记住当前定位标签的 i18n key，供语言切换时重渲染
let geoFailed = false; // 定位失败标记，供语言切换时重渲染 hint

function updateHint() {
  const el = document.getElementById("hint");
  if (userPos) {
    el.textContent = tf("hint_pos", getLang(), {
      lat: userPos.lat.toFixed(3), lon: userPos.lon.toFixed(3),
    });
  }
}

function setUserPos(lat, lon, labelKey) {
  userPos = { lat, lon };
  userPosLabelKey = labelKey;
  if (userMarker) userMarker.remove();
  userMarker = L.marker([lat, lon]).addTo(map).bindPopup(t(labelKey, getLang()));
  updateHint();
  loadNearby();
}

navigator.geolocation?.getCurrentPosition(
  (p) => { setUserPos(p.coords.latitude, p.coords.longitude, "pos_mine"); map.setView([p.coords.latitude, p.coords.longitude], 8); },
  () => { geoFailed = true; document.getElementById("hint").textContent = t("hint_locate_fail", getLang()); }
);
map.on("click", (e) => setUserPos(e.latlng.lat, e.latlng.lng, "pos_picked"));

const modal = document.getElementById("modal");
const modalBody = document.getElementById("modalBody");
function showModal(html) { modalBody.innerHTML = html; modal.classList.remove("hidden"); }
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallback = data.error?.message || tf("err_request", getLang(), { status: res.status });
    throw new Error(tError(data.error?.code, fallback, getLang()));
  }
  return data;
}

// ---- 投瓶 ----
document.getElementById("dropBtn").onclick = () => {
  if (!userPos) return alert(t("alert_need_pos", getLang()));
  showModal(`
    <h3>${t("drop_modal_title", getLang())}</h3>
    <textarea id="letter" maxlength="500" placeholder="${t("drop_placeholder", getLang())}"></textarea>
    <label class="open-reply" style="display:block;margin:8px 0;font-size:13px;color:#4a5568"><input type="checkbox" id="openReply" style="margin-right:6px;vertical-align:middle"> ${t("open_reply_label", getLang())}</label>
    <p class="error" id="dropErr"></p>
    <button id="submitDrop">${t("drop_submit", getLang())}</button>`);
  document.getElementById("submitDrop").onclick = async () => {
    try {
      const content = document.getElementById("letter").value;
      const data = await api("/api/bottles", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, lat: userPos.lat, lon: userPos.lon, lang: getLang(),
          open_reply: document.getElementById("openReply").checked }),
      });
      saveMine(data.token);
      const url = `${location.origin}/b/${data.token}`;
      showModal(`
        <h3>${t("drop_success_title", getLang())}</h3>
        <p>${tf("drop_success_body", getLang(), { km: data.snapped_km })}</p>
        <a class="token-link" href="${escapeHtml(url)}">${escapeHtml(url)}</a>
        <button id="copyLink">${t("copy_link", getLang())}</button>`);
      document.getElementById("copyLink").addEventListener("click", async (e) => {
        try {
          await navigator.clipboard.writeText(url);
          const btn = e.currentTarget;
          btn.textContent = t("copied", getLang());
          setTimeout(() => { btn.textContent = t("copy_link", getLang()); }, 1500);
        } catch {
          alert(t("copy_fail", getLang()));
        }
      });
      L.marker([data.position.lat, data.position.lon]).addTo(map).bindPopup(t("popup_launch", getLang())).openPopup();
      map.setView([data.position.lat, data.position.lon], 7);
    } catch (e) { document.getElementById("dropErr").textContent = e.message; }
  };
};

// ---- 我的瓶子 ----
function loadMine() {
  try {
    const mine = JSON.parse(localStorage.myBottles || "[]");
    return Array.isArray(mine) ? mine : [];
  } catch { return []; }
}
function saveMine(token) {
  const mine = loadMine();
  mine.push({ token, created_at: new Date().toISOString() });
  localStorage.myBottles = JSON.stringify(mine);
  renderMine();
}
function renderMine() {
  const mine = loadMine();
  document.getElementById("mine").innerHTML = mine.length
    ? `<h3>${t("mine_title", getLang())}</h3>` + mine.map((b) =>
        `<div class="bottle-item"><a href="/b/${escapeHtml(b.token)}">${
          tf("mine_item", getLang(), { date: escapeHtml(b.created_at.slice(0, 10)) })
        }</a></div>`).join("")
    : "";
}
renderMine();

// ---- 视野内的瓶子（拖动地图浏览整片海）+ 轨迹 ----
const viewLayer = L.layerGroup().addTo(map); // 视野内所有瓶子（漂流+搁浅）
const trajLayer = L.layerGroup().addTo(map); // 当前选中瓶子的轨迹

let viewTimer = null;
function scheduleLoadView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(loadView, 400); // 防抖：拖动/缩放停下后再加载
}
map.on("moveend", scheduleLoadView);

async function loadView() {
  const b = map.getBounds();
  const qs = `n=${b.getNorth()}&s=${b.getSouth()}&e=${b.getEast()}&w=${b.getWest()}`;
  try {
    const { bottles, truncated } = await api(`/api/bottles/view?${qs}`);
    viewLayer.clearLayers();
    for (const bo of bottles) {
      const marker = bo.status === "beached"
        ? L.marker([bo.lat, bo.lon])
        : L.circleMarker([bo.lat, bo.lon],
            { radius: 6, color: "#4fc3f7", weight: 2, fillColor: "#4fc3f7", fillOpacity: 0.6 });
      marker.addTo(viewLayer).on("click", () => showTrajectory(bo));
    }
    const note = document.getElementById("viewNote");
    if (note) note.textContent = truncated ? t("view_truncated", getLang()) : "";
  } catch (e) { /* 视野加载失败不打断主流程 */ }
}

function havKm(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, dla = (la2 - la1) * r, dlo = (lo2 - lo1) * r;
  const a = Math.sin(dla / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dlo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// 点击瓶子：画出它的漂流轨迹（只看轨迹，不显示信件内容）
async function showTrajectory(bo) {
  trajLayer.clearLayers();
  try {
    const data = await api(`/api/bottles/${bo.public_id}/trajectory`);
    const pts = data.track.map((p) => [p.lat, p.lon]);
    if (pts.length > 1)
      L.polyline(pts, { color: "#e040fb", weight: 3, opacity: 0.85 }).addTo(trajLayer);
    if (pts.length) {
      L.circleMarker(pts[0], { radius: 5, color: "#4fc3f7", fillColor: "#4fc3f7", fillOpacity: 1 })
        .addTo(trajLayer).bindPopup(t("popup_start", getLang()));
      L.circleMarker(pts[pts.length - 1],
        { radius: 6, color: "#e040fb", fillColor: "#e040fb", fillOpacity: 1 }).addTo(trajLayer);
    }
    const statusLabel = bo.status === "beached"
      ? t("status_beached_short", getLang()) : t("status_drifting", getLang());
    const box = document.createElement("div");
    box.innerHTML = `<div>${tf("traj_popup", getLang(),
      { status: statusLabel, days: bo.days_at_sea, km: Math.round(bo.distance_km) })}</div>`;
    // 搁浅瓶：open_reply 瓶任何人可回；普通瓶仅你 30km 内可回（远则给提示）
    if (bo.status === "beached") {
      if (bo.open_reply) {
        const badge = document.createElement("div");
        badge.textContent = t("open_badge", getLang());
        badge.style.cssText = "margin-top:4px;color:#2f6aa0;font-size:12px";
        box.appendChild(badge);
      }
      const near = userPos && havKm(userPos.lat, userPos.lon, bo.lat, bo.lon) <= 30;
      if (bo.open_reply || near) {
        const btn = document.createElement("button");
        btn.className = "secondary";
        btn.style.marginTop = "6px";
        btn.textContent = t("read_pick_btn", getLang());
        btn.onclick = () => { map.closePopup(); openBottle(bo); };
        box.appendChild(btn);
      } else {
        const hint = document.createElement("div");
        hint.textContent = t("only_near_hint", getLang());
        hint.style.cssText = "margin-top:6px;color:#888;font-size:12px";
        box.appendChild(hint);
      }
    }
    L.popup().setLatLng(pts[pts.length - 1] || [bo.lat, bo.lon]).setContent(box).openOn(map);
  } catch (e) { /* ignore */ }
}

// ---- 就近可捡的搁浅瓶（可读信+回信）----
async function loadNearby() {
  if (!userPos) return;
  const el = document.getElementById("nearby");
  try {
    const { bottles } = await api(`/api/nearby?lat=${userPos.lat}&lon=${userPos.lon}`);
    el.innerHTML = `<h3>${tf("nearby_title", getLang(), { n: bottles.length })}</h3>` + (bottles.length === 0
      ? `<p class="hint">${t("nearby_empty", getLang())}</p>` : "");
    for (const b of bottles) {
      const item = document.createElement("div");
      item.className = "bottle-item";
      item.innerHTML = `${tf("nearby_item", getLang(), { days: b.days_at_sea, km: Math.round(b.distance_km) })}
  ${(() => {
    const n = redriftDaysLeft(b.beached_at, Date.now());
    return n > 0 ? tf("redrift_countdown", getLang(), { n }) : t("redrift_soon", getLang());
  })()}
  <button class="secondary" style="margin-top:6px">${t("read_pick_btn", getLang())}</button>`;
      item.querySelector("button").onclick = () => openBottle(b);
      el.appendChild(item);
    }
  } catch (e) { el.innerHTML = `<p class="error">${e.message}</p>`; }
}

// ---- 读信 + 捡瓶 ----
async function openBottle(b) {
  try {
    const { messages } = await api(`/api/bottles/${b.public_id}/read`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat: userPos.lat, lon: userPos.lon }),
    });
    showModal(`
      <h3>${tf("letters_title", getLang(), { n: messages.length })}</h3>
      ${messages.map((m) => `<div class="letter">${escapeHtml(m.content)}
        <div class="meta">${escapeHtml(m.created_at.slice(0, 10))}</div></div>`).join("")}
      <h3>${t("reply_title", getLang())}</h3>
      <textarea id="reply" maxlength="500" placeholder="${t("reply_placeholder", getLang())}"></textarea>
      <p class="error" id="pickErr"></p>
      <button id="submitPick">${t("reply_submit", getLang())}</button>`);
    document.getElementById("submitPick").onclick = async () => {
      try {
        const data = await api(`/api/bottles/${b.public_id}/pickup`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: document.getElementById("reply").value, lat: userPos.lat, lon: userPos.lon }),
        });
        saveMine(data.token);
        const url = `${location.origin}/b/${data.token}`;
        showModal(`
          <h3>${t("pickup_success_title", getLang())}</h3>
          <p>${t("pickup_success_body", getLang())}</p>
          <a class="token-link" href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
        loadNearby();
        scheduleLoadView(); // 瓶子由搁浅变漂流，刷新地图 marker
      } catch (e) { document.getElementById("pickErr").textContent = e.message; }
    };
  } catch (e) { alert(e.message); }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// ---- 语言切换：重渲染动态区（静态区由 i18n.js applyI18n 处理）----
window.addEventListener("i18n:changed", () => {
  if (userPos && userPosLabelKey) {
    updateHint();
  } else if (geoFailed) {
    document.getElementById("hint").textContent = t("hint_locate_fail", getLang());
  }
  if (userMarker && userPosLabelKey) userMarker.setPopupContent(t(userPosLabelKey, getLang()));
  renderMine();
  loadNearby();
  trajLayer.clearLayers(); // 清掉旧语言的轨迹弹窗
  scheduleLoadView();
  modal.classList.add("hidden"); // 关掉可能开着的弹窗，避免旧语言残留
});

// 页面载入即按当前视野加载一次（不必等定位）
scheduleLoadView();
