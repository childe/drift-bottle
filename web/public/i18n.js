// 漂流瓶界面多语言。浏览器 <script src> 全局加载；Node 可 require（末尾 CommonJS 导出）。
const SUPPORTED = ["zh", "en"];

const I18N = {
  zh: {
    doc_title_home: "漂流瓶 · 让真实的洋流带走你的信",
    app_title: "🍾 漂流瓶",
    drop_btn: "写一封信，投进大海",
    hint_locating: "正在定位…（也可以点击地图选择位置）",
    pos_mine: "我的位置",
    pos_picked: "已选位置",
    hint_pos: "位置：{lat}, {lon}（点击地图可修改）",
    hint_locate_fail: "定位失败，点击地图选择位置",
    err_request: "请求失败（{status}）",
    alert_need_pos: "请先允许定位，或点击地图选择位置",
    drop_modal_title: "写一封信",
    drop_placeholder: "写点什么吧，最多500字。洋流会把它带向远方…",
    drop_submit: "投进大海",
    drop_success_title: "🌊 瓶子已入海！",
    drop_success_body: "入海点距你 {km} km。收好你的追踪链接（仅此一次，丢了找不回）：",
    copy_link: "复制链接",
    copied: "✓ 已复制",
    copy_fail: "复制失败，请手动选择链接复制",
    popup_launch: "你的瓶子入海点",
    mine_title: "我的瓶子",
    mine_item: "🍾 {date} 投出的瓶子",
    nearby_title: "附近搁浅的瓶子（{n}）",
    nearby_empty: "30km 内暂时没有。常回来看看～",
    nearby_item: "🏝️ 漂了 {days} 天、{km} km",
    read_pick_btn: "读信 / 捡起",
    nearby_popup: "🏝️ 搁浅瓶：漂了 {days} 天",
    letters_title: "🍾 瓶中信（{n} 封）",
    reply_title: "写下你的回复，送它回大海",
    reply_placeholder: "最多500字",
    reply_submit: "回复并重新投放",
    pickup_success_title: "🌊 它又出发了！",
    pickup_success_body: "这是你的追踪链接，可以看它接下来漂向哪里：",
    doc_title_track: "瓶子去哪儿了 · 漂流瓶",
    track_title: "🍾 瓶子去哪儿了",
    loading: "加载中…",
    back_home: "← 回首页",
    track_not_found: "没有找到这只瓶子。链接是否完整？",
    status_beached: "🏝️ 已搁浅，{n} 天后随潮水再漂",
    status_beached_soon: "🏝️ 即将随潮水再漂",
    redrift_countdown: "· {n} 天后再漂",
    redrift_soon: "· 即将再漂",
    status_drifting: "🌊 正在漂流",
    track_status: "状态：{s}",
    track_start: "启程：{date}（{days} 天前）",
    track_distance: "里程：{km} km",
    popup_start: "入海点",
    popup_beached_here: "🏝️ 搁浅于此",
    popup_here: "🌊 目前在这里",
    track_letters_title: "瓶中信（{n} 封）",
    err_bad_content: "内容不能为空且不超过500字",
    err_bad_coords: "坐标不合法",
    err_no_ocean: "找不到可投放的海域",
    err_not_found: "找不到这只瓶子",
    err_too_far: "你离这只瓶子太远了",
    err_already_picked: "这只瓶子刚被别人捡走了",
    err_rejected: "内容未通过审核",
    err_moderation_unavailable: "审核服务暂不可用，请稍后再试",
    lang_label: "语言",
  },
  en: {
    doc_title_home: "Drift Bottle · Let real ocean currents carry your letter",
    app_title: "🍾 Drift Bottle",
    drop_btn: "Write a letter, cast it to sea",
    hint_locating: "Locating…(or tap the map to choose a spot)",
    pos_mine: "My location",
    pos_picked: "Chosen location",
    hint_pos: "Location: {lat}, {lon} (tap map to change)",
    hint_locate_fail: "Location failed. Tap the map to choose a spot.",
    err_request: "Request failed ({status})",
    alert_need_pos: "Please allow location, or tap the map to choose a spot.",
    drop_modal_title: "Write a letter",
    drop_placeholder: "Write something, up to 500 characters. The currents will carry it far…",
    drop_submit: "Cast to sea",
    drop_success_title: "🌊 Your bottle is adrift!",
    drop_success_body: "Launched {km} km from you. Save your tracking link (shown once—keep it safe):",
    copy_link: "Copy link",
    copied: "✓ Copied",
    copy_fail: "Copy failed. Please select and copy the link manually.",
    popup_launch: "Your bottle's launch point",
    mine_title: "My bottles",
    mine_item: "🍾 Bottle cast on {date}",
    nearby_title: "Beached bottles nearby ({n})",
    nearby_empty: "None within 30 km yet. Check back soon~",
    nearby_item: "🏝️ Drifted {days} days, {km} km",
    read_pick_btn: "Read / Pick up",
    nearby_popup: "🏝️ Beached bottle: drifted {days} days",
    letters_title: "🍾 Letters in the bottle ({n})",
    reply_title: "Write your reply and send it back to sea",
    reply_placeholder: "Up to 500 characters",
    reply_submit: "Reply and cast again",
    pickup_success_title: "🌊 Off it goes again!",
    pickup_success_body: "Here's your tracking link to see where it drifts next:",
    doc_title_track: "Where's the bottle · Drift Bottle",
    track_title: "🍾 Where's the bottle",
    loading: "Loading…",
    back_home: "← Back to home",
    track_not_found: "Bottle not found. Is the link complete?",
    status_beached: "🏝️ Beached, re-drifts in {n} days",
    status_beached_soon: "🏝️ Beached, about to re-drift",
    redrift_countdown: "· re-drifts in {n}d",
    redrift_soon: "· re-drifting soon",
    status_drifting: "🌊 Drifting",
    track_status: "Status: {s}",
    track_start: "Set off: {date} ({days} days ago)",
    track_distance: "Distance: {km} km",
    popup_start: "Launch point",
    popup_beached_here: "🏝️ Beached here",
    popup_here: "🌊 Currently here",
    track_letters_title: "Letters in the bottle ({n})",
    err_bad_content: "Content must be 1-500 characters",
    err_bad_coords: "Invalid coordinates",
    err_no_ocean: "No launchable ocean nearby",
    err_not_found: "Bottle not found",
    err_too_far: "You're too far from this bottle",
    err_already_picked: "This bottle was just picked up by someone else",
    err_rejected: "Content didn't pass moderation",
    err_moderation_unavailable: "Moderation service is unavailable, please try again later",
    lang_label: "Language",
  },
};

function t(key, lang) {
  const dict = I18N[lang] || I18N.en;
  if (dict && dict[key] !== undefined) return dict[key];
  if (I18N.en[key] !== undefined) return I18N.en[key];
  return key;
}

function tf(key, lang, params) {
  let s = t(key, lang);
  if (params) for (const k of Object.keys(params)) s = s.split("{" + k + "}").join(String(params[k]));
  return s;
}

function tError(code, fallback, lang) {
  if (code && I18N.en["err_" + code] !== undefined) return t("err_" + code, lang);
  return fallback;
}

const REDRIFT_DAYS = 7;

function redriftDaysLeft(beachedAtIso, nowMs) {
  const elapsed = (nowMs - Date.parse(beachedAtIso)) / 86400000;
  return Math.max(0, Math.ceil(REDRIFT_DAYS - elapsed));
}

function resolveLang(stored, navLang) {
  if (stored && SUPPORTED.includes(stored)) return stored;
  if (navLang && navLang.toLowerCase().startsWith("zh")) return "zh";
  return "en";
}

// ---- 以下为浏览器专用（Node 环境不执行）----
let currentLang = "en";
function getLang() { return currentLang; }

function applyI18n(lang) {
  currentLang = lang;
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"), lang);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph"), lang));
  });
  const titleEl = document.querySelector("title[data-i18n]");
  if (titleEl) document.title = t(titleEl.getAttribute("data-i18n"), lang);
  document.querySelectorAll("[data-lang-btn]").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-lang-btn") === lang);
  });
}

function setLang(lang) {
  try { localStorage.lang = lang; } catch {}
  applyI18n(lang);
  window.dispatchEvent(new Event("i18n:changed"));
}

function initI18n() {
  let stored = null;
  try { stored = localStorage.lang; } catch {}
  applyI18n(resolveLang(stored, navigator.language));
  document.querySelectorAll("[data-lang-btn]").forEach((el) => {
    el.addEventListener("click", () => setLang(el.getAttribute("data-lang-btn")));
  });
}

if (typeof document !== "undefined") initI18n();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { I18N, t, tf, tError, resolveLang, SUPPORTED, REDRIFT_DAYS, redriftDaysLeft };
}
