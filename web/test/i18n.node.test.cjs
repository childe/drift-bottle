const test = require("node:test");
const assert = require("node:assert");
const { t, tf, tError, resolveLang, SUPPORTED, I18N } = require("../public/i18n.js");

test("SUPPORTED 是 zh/en", () => {
  assert.deepStrictEqual(SUPPORTED, ["zh", "en"]);
});

test("t 命中当前语言", () => {
  assert.strictEqual(t("drop_btn", "en"), I18N.en.drop_btn);
  assert.strictEqual(t("drop_btn", "zh"), I18N.zh.drop_btn);
});

test("t 缺 key 回退英文，再缺回退 key 本身", () => {
  // 构造：假设某 key 只在 en 有——用真实存在的 key 验证 en 回退
  assert.strictEqual(t("drop_btn", "fr"), I18N.en.drop_btn); // 不支持语言回退 en
  assert.strictEqual(t("__nonexistent__", "en"), "__nonexistent__"); // 连 en 都无 → key
});

test("tf 替换占位符", () => {
  const s = tf("nearby_item", "en", { days: 3, km: 42 });
  assert.ok(s.includes("3") && s.includes("42"));
  assert.ok(!s.includes("{days}") && !s.includes("{km}"));
});

test("tError 有映射用本地化，无映射用 fallback", () => {
  assert.strictEqual(tError("rejected", "backend msg", "en"), I18N.en.err_rejected);
  assert.strictEqual(tError("weird_unknown_code", "backend msg", "en"), "backend msg");
  assert.strictEqual(tError(undefined, "backend msg", "en"), "backend msg");
});

test("resolveLang: 受支持的 stored 优先", () => {
  assert.strictEqual(resolveLang("en", "zh-CN"), "en");
  assert.strictEqual(resolveLang("zh", "en-US"), "zh");
});

test("resolveLang: stored 非法则看 navLang", () => {
  assert.strictEqual(resolveLang(null, "zh-CN"), "zh");
  assert.strictEqual(resolveLang("fr", "zh-TW"), "zh"); // 不支持的 stored 忽略
  assert.strictEqual(resolveLang(undefined, "en-US"), "en");
  assert.strictEqual(resolveLang(undefined, "fr-FR"), "en"); // 非 zh 一律 en
  assert.strictEqual(resolveLang(undefined, undefined), "en"); // 兜底 en
});

test("每个 zh key 都有对应 en key（完整性）", () => {
  const zhKeys = Object.keys(I18N.zh).sort();
  const enKeys = Object.keys(I18N.en).sort();
  assert.deepStrictEqual(zhKeys, enKeys);
});
