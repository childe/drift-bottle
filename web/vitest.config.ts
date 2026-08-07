import { defineConfig, defaultExclude } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-01",
        d1Databases: ["DB"],
        // 注意: bindings 传对象数组依赖 Miniflare 的 JSON 序列化行为，官方 schema 未承诺
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    // i18n.node.test.cjs 是 node --test 专用（test:i18n script），用真实 fs 读 public/i18n.js；
    // 在 vitest 的 workerd 沙箱里没有真实文件系统会崩，故从 vitest 收集中排除。
    exclude: [...defaultExclude, "test/i18n.node.test.cjs"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
