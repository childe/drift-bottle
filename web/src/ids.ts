const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const MAX = 256 - (256 % ALPHABET.length); // 拒绝采样去除模偏差

export function randomId(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < MAX && out.length < length) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join("");
}

export const newToken = () => randomId(21);
export const newPublicId = () => randomId(12);
