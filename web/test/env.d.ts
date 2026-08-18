/// <reference types="@cloudflare/vitest-pool-workers/types" />

// v0.20.1 中 cloudflare:test 的 env 类型为 Cloudflare.Env，故通过全局命名空间增强声明绑定
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
    AI: Ai;
    ASSETS: Fetcher;
    OG: R2Bucket;
  }
}

declare module "cloudflare:test" {
  interface ProvidedEnv extends Cloudflare.Env {}
}
