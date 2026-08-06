# 🍾 漂流瓶

匿名漂流瓶：写一封信投进大海，真实洋流带它漂流；搁浅后被岸边的人捡起、回复、再投回。

- 前端+API：Cloudflare Workers (Hono) + D1 + Workers AI（内容审核）
- 洋流模拟：CMEMS 全球表层日均流场，GitHub Actions 每日推进，Python/numpy RK2 积分
- 设计文档：docs/superpowers/specs/2026-08-04-drift-bottle-design.md

## 本地开发

```bash
cd web && npm i && npm test && npx wrangler dev
cd simulation && uv sync && uv run pytest
```

## 部署

```bash
cd web
npx wrangler d1 create drift-bottle   # 把 database_id 填入 wrangler.toml
npx wrangler d1 migrations apply drift-bottle --remote
npx wrangler deploy
```

GitHub Secrets（Actions 用）：CMEMS_USERNAME / CMEMS_PASSWORD /
CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_DATABASE_ID / CLOUDFLARE_API_TOKEN
