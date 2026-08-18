# OG 社交预览卡 设计（Issue #3）

**Issue:** #3 追踪页可分享的 OG 社交预览卡
**日期:** 2026-08-18

## 目标

分享 `/b/{token}` 链接到社交/IM（微信、X、Telegram、Facebook、LINE…）时，抓取到一张**带真实洋流轨迹 + 里程 + 天数**的本地化预览卡，把「一只瓶子漂了多远、多久」变成可炫耀、可传播的视觉，驱动用户自发分享。

## 关键约束（不可绕过）

1. 社交平台抓取的 `og:image` 必须是 **PNG/JPEG**，不支持 SVG。
2. 同一个 URL 对全球所有访客只能有**一张固定的图**——爬虫不区分语言，平台还会缓存。所以卡片文案在生成时就选定一种语言（按投瓶人语言），无法按访客切换。
3. Cloudflare Workers 免费版**每请求 CPU ≤ 10ms**，实时把 1200×630 栅格化会超时。因此图**不在 Worker 实时生成**，而是每日预渲染后存好，Worker 只做廉价读取。

## 架构总览

```
每日 GitHub Actions
  ├─ advance.py            推进所有瓶子（现有）
  └─ og_card.py（新）       对每个活跃瓶子渲染 1200×630 PNG
                            └─ boto3 → R2 (S3 API) 覆盖 og/{public_id}.png

用户分享 /b/{token}
  └─ Worker（动态 HTML）    查 token→bottle，注入 per-bottle <meta og:*>
                            og:image = {origin}/og/{public_id}.png?d=YYYYMMDD

爬虫抓 og:image → /og/{public_id}.png
  └─ Worker                读 R2 对象返回；缺失→回退默认卡 og-default.png
```

数据只走两条：**写**由每日 Python 经 S3 API 上传（外部，需密钥）；**读**由 Worker 经原生 R2 绑定（无需密钥）。

## 组件

### 1. 数据模型：`bottles.lang`

- 新增 migration `web/migrations/0002_bottle_lang.sql`：
  ```sql
  ALTER TABLE bottles ADD COLUMN lang TEXT NOT NULL DEFAULT 'en';
  ```
- 语言只用于**渲染卡片文案**，不影响其它逻辑。允许值 `zh` / `en`，其它一律存 `en`。

### 2. 投瓶接口捕获 lang（`web/src/index.ts` `POST /api/bottles`）

- 请求体增收 `lang` 字段；白名单校验：`lang === 'zh' ? 'zh' : 'en'`（缺失/非法→`en`）。
- 写入 `bottles` 的 `lang` 列。
- 前端 `web/public/app.js` 投瓶时 body 带上 `lang: resolveLang()`（i18n.js 已导出 `resolveLang`）。
- **pickup 重投不改 lang**：`POST /api/bottles/:publicId/pickup` 的 UPDATE 不触碰 `lang`，保持原瓶语言。

### 3. R2 存储

- Bucket `drift-bottle-og`（**已创建**）。
- `wrangler.toml` 增加绑定：
  ```toml
  [[r2_buckets]]
  binding = "OG"
  bucket_name = "drift-bottle-og"
  ```
- `Env` 类型增加 `OG: R2Bucket`。
- 对象 key = `og/{public_id}.png`，每日覆盖。**用 public_id 不用 token**——图 URL 进入社交平台缓存/日志时不泄露能力令牌。

### 4. 每日渲染 `simulation/og_card.py`

- 独立模块 + `main()`，作为 daily-drift.yml 中 **advance.py 之后的独立步骤**运行；渲染失败不影响已完成的模拟。
- 流程：
  1. 复用 `d1.py` 从 D1 查所有**活跃瓶子**（`status IN ('drifting','beached')`）的 `public_id, status, distance_km, created_at, lang` 及各自 `track_points`（按 ts 升序 lat/lon）。
  2. 逐瓶 `render_card(...) -> bytes`（PNG）。
  3. boto3 `put_object(Bucket, Key=f"og/{public_id}.png", Body=png, ContentType="image/png")`，endpoint 指向 R2 S3 endpoint。
  4. **逐瓶 try/except**：单瓶渲染或上传失败只记日志并继续，不中断整批。
- 依赖新增（`simulation/pyproject.toml`）：`pillow`、`boto3`。numpy 已有。
- 读取环境变量：`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ENDPOINT`、`R2_BUCKET`。

#### 口径一致性（重要）

天数与里程都取**瓶子诞生至今的累计**，避免混用当前航段：
- `days = floor((now - created_at) / 1天)`（`created_at` 永不变）。
- `distance = round(distance_km)`（`distance_km` 为累计，pickup/redrift 不清零）。

### 5. 卡片视觉规格（轨迹主视觉 · 本地化）

- 画布 **1200×630**（OG 标准，等价 twitter `summary_large_image`）。
- 背景：深海蓝渐变（顶部约 `#0a2a43` → 底部约 `#12507a`）。
- 陆地：从现有 `web/public/ocean-mask.bin`（1/12° 位图，`idx = iy*4320+ix`，bit=1 为可投放海洋）采样，裁剪窗内**非海洋**格子画成比背景略亮的淡陆地色（`#17394f` 一类）。取不到 mask 时降级为纯海洋底。
- 投影：等距圆柱线性映射 `x=(lon+180)/360`、`y=(90-lat)/180`，裁剪到轨迹 bbox + 留白（bbox 过小时设最小跨度，避免单点瓶被放到无意义的极端缩放）。
- 轨迹：折线**蓝(`#4fc3f7`)→品红(`#e040fb`)** 渐变；起点空心圈，当前点实心点带微光。
- 顶部左：品牌 `🍾 漂流瓶`（zh）/ `🍾 Drift Bottle`（en），白色粗体。
- 底部一行统计（千分位）：
  - zh 漂流中：`漂了 3,200 公里 · 48 天 · 🌊 漂流中`
  - zh 搁浅：`漂了 3,200 公里 · 48 天 · 🏖️ 搁浅`
  - en 漂流中：`Drifted 3,200 km · 48 days · 🌊 Drifting`
  - en 搁浅：`Drifted 3,200 km · 48 days · 🏖️ Beached`
- 字体：中文用 Noto Sans CJK，拉丁/数字用 Noto/DejaVu。emoji（🍾🌊🏖️）优先 Noto Color Emoji + `embedded_color=True`；**若 CI 渲染不稳，退化为 Pillow 手绘的小矢量图标**（瓶/波浪/沙滩），文案不含 emoji。字体在 CI 用 apt 安装。

### 6. Worker `/b/{token}` 改动态 HTML（`web/src/index.ts`）

- 现状 `app.get("/b/*", ...)` 直接回代 `track.html`。改为：
  1. 从路径解析 token，查 `SELECT b.public_id, b.status, b.distance_km, b.created_at, b.lang FROM tokens t JOIN bottles b ON b.id=t.bottle_id WHERE t.token=?`。
  2. **查不到 / DB 异常** → 原样回代 `track.html`（不注入），前端照常报错。页面绝不因预览卡逻辑而 500。
  3. 查到 → 从 ASSETS 取 `track.html` 文本，在 `</head>` 前注入：
     - `og:type=website`、`og:image`、`og:image:width=1200`、`og:image:height=630`
     - `og:title`、`og:description`、`og:url`
     - `twitter:card=summary_large_image`、`twitter:title`、`twitter:description`、`twitter:image`
- `og:image` = `${origin}/og/${public_id}.png?d=${YYYYMMDD}`（`origin` 取自请求 URL，兼容 driftbottle.love 与 workers.dev；`?d=` 日戳用于每日破平台缓存）。
- 文案按 `lang` 本地化，注入内容做 HTML 属性转义：
  - og:title zh：`一只漂流了 48 天的瓶子 · 漂流瓶`；en：`A bottle adrift for 48 days · Drift Bottle`
  - og:description = 品牌 slogan：zh `跟随真实洋流已漂 3,200 公里。写一封信，余下的交给洋流与命运。`；en `Carried 3,200 km by real ocean currents. Write a letter. Leave the rest to the currents.`
- `wrangler.toml` 的 `run_worker_first` 保持含 `/b/*`（已在）。

### 7. Worker `/og/{public_id}.png`（`web/src/index.ts`）

- 新路由 `app.get("/og/:file", ...)`：从 `:file` 剥去 `.png` 得 public_id（校验形如 12 位字符，非法→默认卡）。
- `const obj = await c.env.OG.get(\`og/${pid}.png\`)`：
  - 命中 → 返回对象体，`Content-Type: image/png`，`Cache-Control: public, max-age=3600`。
  - 未命中 / 异常 → 回退 ASSETS 的 `/og-default.png`，同样 200。
- `wrangler.toml` 的 `run_worker_first` 增加 `/og/*`，确保命中 Worker 而非静态资源直出。

### 8. 默认兜底卡

- `web/public/og-default.png`：1200×630 品牌卡（同色系 + slogan），用于第 0 天、尚未渲染、或渲染缺失时。随仓库提交（可由一段一次性脚本用 Pillow 生成后落盘）。

## 隐私与安全边界

- 卡片与 meta **只含已公开信息**：轨迹点、累计里程、天数、状态、品牌语。
- **绝不含**信件正文、token、投瓶人身份。
- 图 URL 用 public_id（本就经 nearby 对 beached 瓶公开），不用 token。
- 注入 HTML 的所有动态文本做属性转义，防止破坏 meta 结构（数字与状态本就受控，转义是纵深防御）。

## 错误处理与降级

| 场景 | 行为 |
|------|------|
| `/b/{token}` token 无效或 DB 异常 | 回代纯 track.html，不注入 meta，页面正常 |
| `/og/{pid}` R2 未命中/异常 | 返回默认卡，200 |
| 单瓶渲染/上传失败 | 记日志，跳过该瓶，继续整批 |
| og_card 整步失败 | 与 advance.py 分步，不影响当日模拟结果 |
| 取不到 ocean-mask | 卡片降级为纯海洋底 |
| Color emoji 字体不可用 | 退化为手绘矢量图标 |

## 测试策略

- **Python（`simulation/tests`）**：
  - `render_card` 对样本轨迹产出非空、尺寸恰为 1200×630 的合法 PNG。
  - 经纬度→像素映射、bbox 裁剪（含单点/极小 bbox 兜底）正确。
  - 语言选择（zh/en）与状态→文案映射正确。
  - 天数/里程口径：days 用 created_at、distance 用 distance_km。
- **TS（`web/test`，workerd/vitest）**：
  - `POST /api/bottles` lang 白名单：zh→zh，en→en，缺失/非法→en。
  - `/b/{token}`：命中→HTML 含带 public_id 的 og:image 与本地化 og:title；未命中→纯 HTML 不含注入。
  - `/og/{pid}`：mock `OG.get` 命中→image/png + 缓存头；未命中→默认卡。
  - 现有测试全部保持通过。

## 部署 / 配置前置项

1. **R2 bucket** `drift-bottle-og` — 已创建 ✓。
2. `wrangler.toml` 加 `OG` 绑定；`run_worker_first` 加 `/og/*`。
3. **D1 迁移**：远端执行 `0002_bottle_lang.sql`（`wrangler d1 migrations apply drift-bottle --remote` 或等价）。
4. **GitHub Actions secrets**（用户在控制台生成 R2 S3 凭证后配置）：
   `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ENDPOINT`（`https://b1a2138fd26363393f42b5fd7b6240d1.r2.cloudflarestorage.com`）、`R2_BUCKET`（`drift-bottle-og`）。
5. **daily-drift.yml**：新增步骤 `apt-get install -y fonts-noto-cjk fonts-noto-color-emoji`；simulation 依赖装 pillow/boto3；跑 og_card 步骤并注入上述 R2 env。
6. `npm run deploy` 部署 Worker。

## 非目标（YAGNI）

- 不做起点海域反向地理编码（不显示海域名）。
- 不做按访客语言切换卡片（OG 机制不支持）。
- 不做动图/视频卡。
- 不在 Worker 里为新瓶实时渲染（新瓶到首次每日渲染前用默认卡兜底，可接受——第 0 天只有一个点无轨迹可画）。
- 不做超出 mask 淡色底的精细海岸线矢量。
