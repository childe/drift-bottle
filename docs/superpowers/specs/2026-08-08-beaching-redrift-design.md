# 漂流瓶 · 搁浅—重漂机制设计

日期：2026-08-08
状态：已与产品负责人逐点确认
前置：MVP + i18n 已上线（https://drift-bottle.rmself.workers.dev）；本设计是增量功能

## 1. 目标与背景

现状：瓶子撞岸即永久搁浅（除非被附近的人捡起）。近岸/半封闭海域投的瓶子可能一两天就搁浅，主人体验为"刚投就卡住了"。目前唯一的防呆是投放点离岸至少一格（~9km 缓冲），只防"出生即搁浅"，不防"很快搁浅"。

真实物理：密封浮力瓶搁浅后常被下一次涨潮/风浪重新带走，多次登陆再离岸，最终有的漂几十年。把"搁浅"建模成永久终点是不真实的简化。

目标：让瓶子**更可能漂远**，且搁浅不再是速死。采用"撞岸→暂时搁浅→自然重漂"的循环，而非人为的"用户手动重投"。

## 2. 状态模型（简化）

瓶子只有两态：`drifting`、`beached`。**取消"永久搁浅"终态**——因选定无上限，搁浅永远是暂时的。

## 3. 核心循环

```
漂流中 ──撞岸──▶ 搁浅(记 beached_at，停在最后海上位置)
                   │  停靠期 7 天内：附近的人可捡起→回复→重投(现有捡瓶玩法，不改)
                   │
             满 7 天无人捡 ──▶ 海水带走：吸附回最近开阔海格 → 重新 drifting → 继续漂
                   │
             (无上限：再撞岸就再停 7 天，循环不息)
```

**参数**：停靠期 `REDRIFT_DAYS = 7`；逃逸上限 = 无（瓶子永不永久搁浅）。

## 4. 每日重漂（simulation/advance.py）

在 `main()` **最开头**处理重漂——**必须早于**现有那句"没有 drifting 瓶就退出"的检查（否则当所有瓶子都搁浅时，重漂永远触发不了，也就永远没有 drifting 瓶）：

1. 查 `status='beached' AND beached_at <= (now_utc - 7天)` 的瓶子
2. 对每个瓶子，把当前坐标吸附到最近的开阔安全海格（见 §5）——**不能停在贴岸的搁浅位置**，否则重漂后下一步又撞岸
3. 批量 `UPDATE`：`status='drifting'`、`beached_at=NULL`、`launched_at=<今天>`、`simulated_to=<今天>`、`lat/lon=<吸附点>`
4. 之后照常执行既有的 drifting 推进逻辑

细节：
- 重漂瓶 `simulated_to=今天`，沿用"当日入水次日漂"规则（次日才被推进）
- 累计里程 `distance_km` **不清零**（那是瓶子一生总里程）；搁浅→重漂的吸附跳跃**不计入**里程（那是"卷回深水"的抽象瞬移，非漂流积分）
- 判定用运行时 `datetime.now(timezone.utc)`；重漂函数接受可注入的 `now` 参数以便测试
- 重漂只改 DB 状态，不需要流场，故放在下载之前；重漂后瓶子进入 drifting 池，被后续 `MIN(simulated_to)` 与推进逻辑正常纳入

## 5. Python 端吸附（新增 simulation/ocean_snap.py）

重漂点需要吸附到开阔海格。复用投瓶用的**同一张**离岸缓冲掩码 `web/public/ocean-mask.bin`（3×3 腐蚀，离岸≥1格；位序已跨语言对齐），逻辑对齐 `web/src/ocean.ts` 的 `snapToOcean`：

- `load_safe_mask(path) -> np.ndarray`：`np.unpackbits(np.fromfile(path, uint8)).reshape(2041, 4320)` 还原布尔安全掩码
- `snap_to_safe(mask, lat, lon) -> (lat, lon)`：算网格索引，所在格安全则原地返回；否则按切比雪夫环外扩找最近安全格，返回其中心坐标；经度环绕、纬度边界视为陆地
- 网格常量 GLO12：`lat0=-80, lon0=-180, dLat=dLon=1/12, nLat=2041, nLon=4320`
- 掩码路径：`advance.py` 在 `simulation/` 运行，掩码在 `../web/public/ocean-mask.bin`（GitHub Actions 仓库结构完整，可达）；掩码加载一次，供当次重漂复用

## 6. 捡瓶（不变）

搁浅期（7 天内）可被 read / pickup，走现有逻辑，**无需改**。捡起并回复后瓶子走正常 pickup（重新 drifting、发新 token），不再等 7 天。

## 7. 前端与 i18n

后端 API **无需改**：`GET /api/nearby` 与 `GET /api/track/:token` 已返回 `beached_at`，前端据此自算倒计时 `N = max(0, ceil(7 - (now - beached_at)/天))`。

- `web/public/track.js`：搁浅瓶状态文案改为体现暂时性，并显示倒计时
- `web/public/app.js`：附近列表的搁浅瓶显示倒计时
- `web/public/i18n.js`：新增/改 key（中/英）
  - `status_beached` 改为「🏝️ 已搁浅，{n} 天后随潮水再漂」/「🏝️ Beached, re-drifts in {n} days」（用 tf 传 {n}）
  - 若 n=0（即将重漂）显示「🏝️ 即将随潮水再漂」/「🏝️ About to re-drift with the tide」
  - `nearby_popup` / 列表项按需追加倒计时（复用同一批 key）

## 8. 测试

- **simulation/tests/test_redrift.py**：
  - `snap_to_safe`：陆地/贴岸点吸附到开阔安全格；开阔点原地返回；经度环绕
  - 重漂判定：`beached_at` 满 7 天 → 重漂（状态/坐标/日期正确、坐标是安全格、里程不计跳跃）；不满 7 天 → 不动
  - 无上限：重漂后仍可再搁浅再重漂（不出现"永久搁浅"状态）
- 既有 simulation 与 web 测试保持全绿
- 部署后冒烟：构造一个 beached 满 7 天的瓶子，跑一次 advance，确认它变回 drifting 且坐标离岸有缓冲

## 9. 已知取舍（backlog，先不做）

- **无上限 = 瓶子永不消失，数据库只增不减**。个人项目短期无碍；未来量大可加"总寿命归档"（如漂满 2 年沉入海底）
- 重漂吸附点若当前流场仍持续向岸，瓶子可能在同一近岸带反复搁浅-重漂（无上限下接受）
- 不做用户手动重投（自动重漂已覆盖需求，且更真实、不破坏"交给命运"的意境）

## 10. 文件影响

- 新增：`simulation/ocean_snap.py`、`simulation/tests/test_redrift.py`
- 改：`simulation/advance.py`（`refloat_beached` 函数 + `main()` 调用 + `REDRIFT_DAYS` 常量）
- 改：`web/public/i18n.js`、`web/public/track.js`、`web/public/app.js`（倒计时展示）
- 不改：后端 `web/src/index.ts`、D1 schema（无新字段——`beached_at` 已存在，重漂只是状态流转）
