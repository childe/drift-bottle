import { describe, it, expect } from "vitest";
import { moderate } from "../src/moderation";

const fakeAi = (impl: () => Promise<unknown>) => ({ run: impl }) as unknown as Ai;

describe("moderate", () => {
  it("safe 判定", async () => {
    const ai = fakeAi(async () => ({ response: "safe" }));
    expect(await moderate(ai, "你好，大海")).toBe("safe");
  });
  it("unsafe 判定", async () => {
    const ai = fakeAi(async () => ({ response: "unsafe\nS1" }));
    expect(await moderate(ai, "bad")).toBe("unsafe");
  });
  it("异常 → unavailable（fail-closed）", async () => {
    const ai = fakeAi(async () => { throw new Error("boom"); });
    expect(await moderate(ai, "x")).toBe("unavailable");
  });
  it("响应不可解析 → unavailable", async () => {
    const ai = fakeAi(async () => ({ response: "???" }));
    expect(await moderate(ai, "x")).toBe("unavailable");
  });
  it("safe 带附加文本 → unavailable（fail-closed，精确匹配）", async () => {
    const ai = fakeAi(async () => ({ response: "safe with caveats" }));
    expect(await moderate(ai, "x")).toBe("unavailable");
  });
});
