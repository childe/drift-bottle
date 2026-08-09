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
    <p class="error" id="dropErr"></p>
    <button id="submitDrop">${t("drop_submit", getLang())}</button>`);
  document.getElementById("submitDrop").onclick = async () => {
    try {
      const content = document.getElementById("letter").value;
      const data = await api("/api/bottles", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, lat: userPos.lat, lon: userPos.lon }),
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

// ---- 附近搁浅瓶 ----
let nearbyLayer = L.layerGroup().addTo(map);
async function loadNearby() {
  if (!userPos) return;
  nearbyLayer.clearLayers();
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
      L.marker([b.lat, b.lon]).addTo(nearbyLayer)
        .bindPopup(tf("nearby_popup", getLang(), { days: b.days_at_sea }))
        .on("click", () => openBottle(b));
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
  modal.classList.add("hidden"); // 关掉可能开着的弹窗，避免旧语言残留
});
