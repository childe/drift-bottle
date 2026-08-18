import { describe, it, expect } from "vitest";
import { escapeAttr, ogTitle, ogDescription, ogMetaTags, injectHead, CardMeta } from "../src/og";

const base: CardMeta = {
  origin: "https://driftbottle.love",
  publicId: "abcABC123456",
  lang: "zh",
  days: 48,
  distanceKm: 3200.4,
  status: "drifting",
  canonicalUrl: "https://driftbottle.love/b/TOKEN",
  dayStamp: "20260818",
};

describe("og-meta", () => {
  it("escapeAttr 转义引号与尖括号", () => {
    expect(escapeAttr(`a"<>&`)).toBe("a&quot;&lt;&gt;&amp;");
  });
  it("ogTitle 本地化", () => {
    expect(ogTitle(base)).toBe("一只漂流了 48 天的瓶子 · 漂流瓶");
    expect(ogTitle({ ...base, lang: "en" })).toBe("A bottle adrift for 48 days · Drift Bottle");
    expect(ogTitle({ ...base, lang: "en", days: 1 })).toBe("A bottle adrift for 1 day · Drift Bottle");
  });
  it("ogDescription 千分位 + slogan", () => {
    expect(ogDescription(base)).toBe("跟随真实洋流已漂 3,200 公里。写一封信，余下的交给洋流与命运。");
    expect(ogDescription({ ...base, lang: "en" })).toBe(
      "Carried 3,200 km by real ocean currents. Write a letter. Leave the rest to the currents."
    );
  });
  it("ogMetaTags 含带 public_id 与 dayStamp 的 og:image、summary_large_image", () => {
    const tags = ogMetaTags(base);
    expect(tags).toContain('property="og:image" content="https://driftbottle.love/og/abcABC123456.png?d=20260818"');
    expect(tags).toContain('name="twitter:card" content="summary_large_image"');
    expect(tags).toContain('property="og:image:width" content="1200"');
  });
  it("injectHead 插到 </head> 前", () => {
    const out = injectHead("<head><title>t</title></head><body>x</body>", "<meta>");
    expect(out).toBe("<head><title>t</title><meta>\n</head><body>x</body>");
  });
});
