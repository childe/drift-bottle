import { defineConfig } from "vitest/config";
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
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
