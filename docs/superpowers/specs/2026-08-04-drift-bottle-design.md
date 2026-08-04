# 漂流瓶（Drift Bottle）产品设计

日期：2026-08-04
状态：已与产品负责人逐节确认

## 1. 产品概述

匿名漂流瓶网页应用：任何人无需注册，在任意位置写一封信投入大海，瓶子按真实洋流（CMEMS 全球流场）每日漂流；搁浅后，附近的人可以捡起、读信、回复、再投回海里。投瓶人与每个捡瓶人各持有一个私有追踪 ID，可随时查看瓶子的完整轨迹与信件链。

核心原则：

- **完全匿名**：无账号体系，追踪凭证即身份（capability URL 模式）
- **真实洋流**：全球覆盖，Copernicus Marine（CMEMS）日均表层流场驱动
- **开放但不失控**：内容经 LLM 审核（拦截色情、暴力等），无人工审核、无防 GPS 作弊
- **零成本运行**：全部落在 Cloudflare 与 GitHub 免费额度内

## 2. 核心产品规则

### 投瓶
1. 用户定位在任意位置（含内陆），系统吸附到**最近的安全海洋格点**作为入海点
2. 写一段文字，≤500 字；Workers AI（Llama Guard 3）审核，不通过直接拒绝、不入库
3. 通过后返回 **21 位追踪 token**（nanoid，CSPRNG 生成）与追踪链接 `/b/{token}`

### 漂流
- 每日批处理推进所有 `drifting` 瓶子 24 小时（内部逐小时 RK2 积分）
- 流速插值遇陆地（NaN）→ 状态转 `beached`，记录搁浅点与时间
- **搁浅不干预**：无自动重新入海，躺到有人捡为止

### 捡瓶（搁浅捡取）
1. 首页展示用户 **30km 半径内**的搁浅瓶（只露 `public_id`、漂流天数、里程、搁浅时间，不露信件与任何 token）
2. 读信不锁瓶：处于 beached 且距离校验通过即可读完整信件链
3. 回复（同样过审核）并提交 → 原子抢占（`UPDATE ... WHERE status='beached'`，行数为 0 → 409 已被捡走）→ 瓶子从搁浅点吸附回最近安全海格重新入海
4. 捡瓶人获得一个**全新的 21 位 token**，与投瓶人的 token 互不知晓、各自有效

### 追踪
- 凭任一有效 token 可看：完整轨迹、当前状态、漂流天数、累计里程、完整信件链
- 未知 token 一律 404，与「从不存在」不可区分

### ID 安全模型
- **追踪 token（21 位，~126 bit 熵）**：读轨迹/信件的唯一凭证，不可枚举
- **public_id（12 位随机短码）**：搁浅瓶的公开引用，仅用于 read/pickup；配合「必须声称在附近」的距离校验，将全库爬取降级为按地理位置逐片查询
- **内部自增 id**：仅用于表间关联与批量更新，永不出库

## 3. 架构（方案 A）

```
GitHub Actions (每日 cron)                Cloudflare
┌─────────────────────────┐      ┌──────────────────────────────┐
│ 1. 拉全球表层日均流场 ~70MB │      │ Worker (Hono)：API + 静态前端  │
│ 2. 从 D1 读 drifting 瓶子  │ ───▶ │ D1 (SQLite)：数据存储          │
│ 3. numpy 批量推进 24h      │ 写回  │ Workers AI：Llama Guard 3 审核 │
│ 4. 搁浅判定 → 状态更新      │  D1  │ 静态资源：前端 + 海洋位图        │
└─────────────────────────┘      └──────────────────────────────┘
```

选型理由：Workers 无法运行 Python 科学计算栈（xarray/NetCDF），模拟放 GitHub Actions（公开仓库免费不限时长）；已验证的原型 Python 代码直接复用。备选的「纯 Cloudflare + JS 重写模拟」留作未来演进。

## 4. 数据模型（D1）

```sql
CREATE TABLE bottles (
  id          INTEGER PRIMARY KEY,       -- 内部 id，不出库
  public_id   TEXT NOT NULL UNIQUE,      -- 12 位随机短码，nearby/read/pickup 用
  status      TEXT NOT NULL,             -- drifting | beached
  lat         REAL NOT NULL,             -- 当前精确位置（模拟终态，权威状态）
  lon         REAL NOT NULL,
  beached_at  TEXT,                      -- 搁浅时间，漂流中为 NULL
  launched_at TEXT NOT NULL,             -- 最近一次入水时间（投瓶或捡起再投时更新）
  distance_km REAL NOT NULL DEFAULT 0,   -- 累计漂流里程
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_bottles_beached ON bottles(status, lat, lon);

CREATE TABLE tokens (
  token      TEXT PRIMARY KEY,           -- 21 位 nanoid
  bottle_id  INTEGER NOT NULL REFERENCES bottles(id),
  role       TEXT NOT NULL,              -- dropper | picker
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  bottle_id  INTEGER NOT NULL REFERENCES bottles(id),
  content    TEXT NOT NULL,              -- ≤500 字，过审后入库
  lat REAL, lon REAL,                    -- 该信的（吸附后）入海点
  created_at TEXT NOT NULL
);

CREATE TABLE track_points (              -- 展示用轨迹，每 6 小时一点
  bottle_id  INTEGER NOT NULL,
  ts         TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL,
  PRIMARY KEY (bottle_id, ts)
);

CREATE TABLE meta (                      -- 模拟水位线等全局状态
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
```

设计要点：

- **bottles.lat/lon 是有意冗余**：附近搁浅瓶查询与每日模拟起点都只需当前位置，物化后可走 `(status, lat, lon)` 索引；track_points 仅供展示（6h 抽稀），二者在同一事务更新
- 轨迹量级：1 万瓶 × 4 点/天 ≈ 1500 万行/年，D1 免费层 5GB 可容纳；超量再做归档抽稀
- 并发捡瓶靠条件 UPDATE 原子抢占，无锁表

## 5. API 设计（单 Worker，Hono）

| 接口 | 说明 |
|---|---|
| `POST /api/bottles` | 投瓶。body `{content, lat, lon}`。校验→审核→海洋吸附→事务写 bottle+message+token(dropper)+首轨迹点。返回 `{token, position, snapped_km}` |
| `GET /api/track/:token` | 凭 token 追踪。返回状态、当前位置、里程、信件链、轨迹点。未知 token 404 |
| `GET /api/nearby?lat=&lon=` | 30km 内搁浅瓶。边界框索引粗筛 + haversine 精筛。返回 `[{public_id, days_at_sea, distance_km, beached_at}]` |
| `POST /api/bottles/:public_id/read` | 读信。body `{lat, lon}`；须 beached 且 ≤30km。返回信件链 |
| `POST /api/bottles/:public_id/pickup` | 回复+再投（原子）。body `{content, lat, lon}`；距离校验→审核→原子抢占（失败 409）→写 message+新 token(picker)。瓶子从搁浅点吸附入海。返回 `{token}` |

错误约定：统一 `{error: {code, message}}`；400 参数错、404 不存在、409 已被捡走、422 审核未通过、503 审核服务不可用。

### 内容审核
- Workers AI `@cf/meta/llama-guard-3-8b`，投瓶与回复共用；判定 unsafe（任何类目）即 422 拒绝，不入库不留痕
- 注意：Llama Guard 3 官方支持语言不含中文。实现时先用中文样本验证判定效果；若不达标，回退方案为 Workers AI 上的通用对话模型 + 审核 prompt 输出结构化判定（接口不变，只换实现）
- **fail-closed**：审核服务故障时拒绝提交（503，提示稍后再试）

### 海洋吸附
- 预生成全球 1/12°「安全投放位图」（~1MB bitmap）：从 CMEMS 流场陆地 NaN 派生，并向海侧收缩一格（2×2 邻域全为海才算安全），瓶子不会出生即搁浅
- 位图作为 Worker 静态资源常驻内存；投瓶/再投时从目标格点螺旋外扩找最近安全海格

## 6. 每日模拟管线（GitHub Actions）

`.github/workflows/daily-drift.yml`，每日 06:00 UTC（CMEMS 前一日分析场发布后）：

1. `copernicusmarine` 拉取全球表层日均 uo/vo（`cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m`，depth 0–1m，~70MB/天）
2. 经 Cloudflare REST API 从 D1 读全部 drifting 瓶子 `(id, lat, lon, distance_km)`
3. numpy 向量化推进：每瓶 24 步 × 1h RK2，空间双线性 + 时间线性插值
4. 搁浅判定：插值邻域含 NaN → beached，记录位置与时间
5. 批量写回：bottles（位置/里程/状态/beached_at）+ track_points（每 6h）+ 水位线，同批提交

健壮性：

- **水位线追赶**：`meta['sim_watermark']` 记录已模拟到的日期；每次运行从水位线+1 推进到最新可用数据日，Actions 挂掉或 CMEMS 晚发布会自动补跑
- **幂等**：写回与水位线同批提交，同一天重跑不重复推进
- **入队时机**：瓶子只推进 `launched_at` 早于模拟日 00:00 UTC 的整天；当日新投或当日被捡起再投的瓶子停在入海点，次日开始漂
- **单瓶容错**：单个瓶子异常（漂出数据边界等）跳过并记日志，不影响整批
- 凭据：CMEMS 账号、Cloudflare API token 均在 GitHub Secrets

## 7. 前端（静态页，同 Worker 托管）

- `/` 首页：Leaflet 地图定位到用户；**投瓶**（写信→拿追踪链接）与**捡瓶**（附近搁浅瓶标记→读信→回复入海）
- `/b/{token}` 追踪页：轨迹地图（时间渐变线）+ 漂流天数/里程 + 信件链时间线
- 手机优先；vanilla JS + Leaflet，无框架；OSM 瓦片
- localStorage 保存本人 token 列表（「我的瓶子」），仍无账号

## 8. 仓库结构与部署

```
drift_bottle/
├─ web/                      # Cloudflare Worker（Hono + TypeScript）
│  ├─ src/index.ts           #   API 路由 + 审核 + 海洋吸附
│  ├─ public/                #   index.html / track.html / app.js / style.css
│  ├─ assets/ocean-mask.bin  #   安全投放位图
│  ├─ schema.sql             #   D1 建表
│  └─ wrangler.toml
├─ simulation/               # Python 模拟引擎（uv 管理）
│  ├─ advance.py             #   每日任务主逻辑
│  ├─ make_mask.py           #   一次性生成海洋位图
│  └─ tests/
├─ .github/workflows/daily-drift.yml
└─ docs/superpowers/specs/
```

- 仓库公开（Actions 免费不限时长，契合开放气质）；凭据全部走 Secrets
- 部署：`wrangler deploy`；D1、Workers、Workers AI、Actions 均免费层，运行成本 0

## 9. 测试与错误处理

- **Python（pytest）**：积分器单测（匀速流场直线漂移、贴岸必搁浅）；水位线追赶与幂等逻辑
- **Worker（vitest + miniflare）**：投瓶→追踪闭环；双人抢瓶后者 409；审核 mock 的拒绝路径；nearby 距离边界
- **E2E 冒烟**：部署后 API 投一个测试瓶，验证 track 返回
- **运维**：Actions 失败 GitHub 自动邮件；Worker 日志走 Cloudflare dashboard

## 10. MVP 明确不做（后续迭代方向）

- windage 风漂、逐小时 SMOC 潮汐流场（近岸更真实）
- 轨迹抽稀归档、防 GPS 伪造、速率限制
- 多语言、瓶子皮肤等产品化装饰
- 纯 Cloudflare 架构演进（JS 重写模拟，摆脱 GitHub 依赖）
