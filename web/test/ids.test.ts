import { describe, it, expect } from "vitest";
import { newToken, newPublicId, randomId } from "../src/ids";

describe("ids", () => {
  it("长度与字符集正确", () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9]{21}$/);
    expect(newPublicId()).toMatch(/^[A-Za-z0-9]{12}$/);
  });
  it("抽样不重复", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => randomId(21)));
    expect(seen.size).toBe(1000);
  });
});
