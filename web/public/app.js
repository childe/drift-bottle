const map = L.map("map").setView([25, 140], 3);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap",
}).addTo(map);

let userPos = null;
let userMarker = null;

function setUserPos(lat, lon, label) {
  userPos = { lat, lon };
  if (userMarker) userMarker.remove();
  userMarker = L.marker([lat, lon]).addTo(map).bindPopup(label);
  document.getElementById("hint").textContent =
    `位置：${lat.toFixed(3)}, ${lon.toFixed(3)}（点击地图可修改）`;
  loadNearby();
}

navigator.geolocation?.getCurrentPosition(
  (p) => { setUserPos(p.coords.latitude, p.coords.longitude, "我的位置"); map.setView([p.coords.latitude, p.coords.longitude], 8); },
  () => { document.getElementById("hint").textContent = "定位失败，点击地图选择位置"; }
);
map.on("click", (e) => setUserPos(e.latlng.lat, e.latlng.lng, "已选位置"));

const modal = document.getElementById("modal");
const modalBody = document.getElementById("modalBody");
function showModal(html) { modalBody.innerHTML = html; modal.classList.remove("hidden"); }
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `请求失败(${res.status})`);
  return data;
}

// ---- 投瓶 ----
document.getElementById("dropBtn").onclick = () => {
  if (!userPos) return alert("请先允许定位，或点击地图选择位置");
  showModal(`
    <h3>写一封信</h3>
    <textarea id="letter" maxlength="500" placeholder="写点什么吧，最多500字。洋流会把它带向远方…"></textarea>
    <p class="error" id="dropErr"></p>
    <button id="submitDrop">投进大海</button>`);
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
        <h3>🌊 瓶子已入海！</h3>
        <p>入海点距你 ${data.snapped_km} km。收好你的追踪链接（仅此一次，丢了找不回）：</p>
        <a class="token-link" href="${url}">${url}</a>
        <button id="copyLink">复制链接</button>`);
      document.getElementById("copyLink").addEventListener("click", () => navigator.clipboard.writeText(url));
      L.marker([data.position.lat, data.position.lon]).addTo(map).bindPopup("你的瓶子入海点").openPopup();
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
    ? `<h3>我的瓶子</h3>` + mine.map((b) =>
        `<div class="bottle-item"><a href="/b/${escapeHtml(b.token)}">🍾 ${escapeHtml(b.created_at.slice(0, 10))} 投出的瓶子</a></div>`).join("")
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
    el.innerHTML = `<h3>附近搁浅的瓶子（${bottles.length}）</h3>` + (bottles.length === 0
      ? `<p class="hint">30km 内暂时没有。常回来看看～</p>` : "");
    for (const b of bottles) {
      const item = document.createElement("div");
      item.className = "bottle-item";
      item.innerHTML = `🏝️ 漂了 ${b.days_at_sea} 天、${Math.round(b.distance_km)} km
        <button class="secondary" style="margin-top:6px">读信 / 捡起</button>`;
      item.querySelector("button").onclick = () => openBottle(b);
      el.appendChild(item);
      L.marker([b.lat, b.lon]).addTo(nearbyLayer)
        .bindPopup(`🏝️ 搁浅瓶：漂了 ${b.days_at_sea} 天`)
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
      <h3>🍾 瓶中信（${messages.length} 封）</h3>
      ${messages.map((m) => `<div class="letter">${escapeHtml(m.content)}
        <div class="meta">${m.created_at.slice(0, 10)}</div></div>`).join("")}
      <h3>写下你的回复，送它回大海</h3>
      <textarea id="reply" maxlength="500" placeholder="最多500字"></textarea>
      <p class="error" id="pickErr"></p>
      <button id="submitPick">回复并重新投放</button>`);
    document.getElementById("submitPick").onclick = async () => {
      try {
        const data = await api(`/api/bottles/${b.public_id}/pickup`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: document.getElementById("reply").value, lat: userPos.lat, lon: userPos.lon }),
        });
        saveMine(data.token);
        const url = `${location.origin}/b/${data.token}`;
        showModal(`
          <h3>🌊 它又出发了！</h3>
          <p>这是你的追踪链接，可以看它接下来漂向哪里：</p>
          <a class="token-link" href="${url}">${url}</a>`);
        loadNearby();
      } catch (e) { document.getElementById("pickErr").textContent = e.message; }
    };
  } catch (e) { alert(e.message); }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
