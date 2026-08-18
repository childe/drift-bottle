export type Lang = "zh" | "en";

export interface CardMeta {
  origin: string;
  publicId: string;
  lang: Lang;
  days: number;
  distanceKm: number;
  status: string;
  canonicalUrl: string;
  dayStamp: string; // YYYYMMDD
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function thousands(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function ogTitle(m: CardMeta): string {
  if (m.lang === "zh") return `一只漂流了 ${m.days} 天的瓶子 · 漂流瓶`;
  return `A bottle adrift for ${m.days} ${m.days === 1 ? "day" : "days"} · Drift Bottle`;
}

export function ogDescription(m: CardMeta): string {
  const km = thousands(m.distanceKm);
  if (m.lang === "zh") return `跟随真实洋流已漂 ${km} 公里。写一封信，余下的交给洋流与命运。`;
  return `Carried ${km} km by real ocean currents. Write a letter. Leave the rest to the currents.`;
}

export function ogMetaTags(m: CardMeta): string {
  const image = escapeAttr(`${m.origin}/og/${m.publicId}.png?d=${m.dayStamp}`);
  const title = escapeAttr(ogTitle(m));
  const desc = escapeAttr(ogDescription(m));
  const url = escapeAttr(m.canonicalUrl);
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${desc}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${desc}">`,
    `<meta name="twitter:image" content="${image}">`,
  ].join("\n");
}

export function injectHead(html: string, tags: string): string {
  return html.replace("</head>", `${tags}\n</head>`);
}
