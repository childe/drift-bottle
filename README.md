# 🍾 Drift Bottle

**Write a letter. Leave the rest to the currents.**

An anonymous message-in-a-bottle for the whole ocean. Write a letter, cast it into the sea from where you are, and watch it drift on **real global ocean currents**. When it washes ashore, someone near that coast can pick it up, read it, reply, and send it back out to sea.

🌊 Live: **[driftbottle.love](https://driftbottle.love)**

---

## What makes it different

Most "message in a bottle" apps move your bottle randomly, or not at all. Drift Bottle moves it the way the ocean actually would.

- **Real ocean currents, not fake motion.** Every bottle is advanced through the daily global surface-current field from [Copernicus Marine (CMEMS)](https://marine.copernicus.eu/) using Lagrangian RK2 integration. The path your bottle takes is a physically plausible drift, not a random walk.
- **Anonymous — no accounts, ever.** There's no sign-up. A bottle *is* its link: a capability token in the URL is the only thing that ties you to it.
- **Real geography decides who finds it.** A bottle beaches where the currents carry it. Only people near *that* coast can pick it up — so where your words end up is genuinely out of your hands.
- **Beaches, waits, then drifts on again.** A beached bottle stays pickable for a while; if no one picks it up, the tide takes it back out and it keeps drifting — indefinitely.
- **Global from day one.** Multilingual UI (中文 / English), multilingual LLM content moderation, and shareable social preview cards that render each bottle's real trajectory.

## How it works

1. **Cast** — write a letter (≤500 chars) and drop it at your location. It snaps to the nearest open ocean and starts drifting.
2. **Drift** — a daily job pulls the latest global currents and advances every active bottle, recording its trajectory.
3. **Beach** — when the currents push it into land, it beaches and becomes discoverable to people nearby.
4. **Pick up & reply** — someone on that coast reads it, adds a reply, and re-casts it from where they are.
5. **Repeat** — the bottle drifts on, carrying a growing thread of letters across the world.

## Built on

- **Frontend + API:** Cloudflare Workers ([Hono](https://hono.dev/)) + D1 (SQLite) + Workers AI (content moderation) + R2 (preview-card storage).
- **Ocean simulation:** CMEMS global daily surface-current fields, advanced every day by a GitHub Actions cron with a vectorized Python/NumPy RK2 integrator.
- **Social preview cards:** the daily job renders each bottle's trajectory to a shareable OG image (Pillow → R2), injected into `/b/{token}` as per-bottle OpenGraph/Twitter meta.
- **Fully serverless**, and comfortably within free tiers.

## Local development

```bash
cd web && npm i && npm test && npx wrangler dev
cd simulation && uv sync && uv run pytest
```

## Deploy

```bash
cd web
npx wrangler d1 create drift-bottle          # put the database_id into wrangler.toml
npx wrangler d1 migrations apply drift-bottle --remote
npx wrangler r2 bucket create drift-bottle-og # preview-card storage
npx wrangler deploy
```

**GitHub Actions secrets** (for the daily simulation + card rendering):
`CMEMS_USERNAME`, `CMEMS_PASSWORD`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

## Design docs

Specs and implementation plans live in [`docs/superpowers/`](docs/superpowers/) — start with the [original design](docs/superpowers/specs/2026-08-04-drift-bottle-design.md).
