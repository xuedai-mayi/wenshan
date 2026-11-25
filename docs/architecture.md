# 问山 · 架构

本文档描述仓库的分层、数据流与关键约定。面向要改代码或接入新实习区的人。

## 分层

```text
┌─────────────────────────────────────────────────────────────┐
│ 页面与 HTTP 接口        packages/intake                      │
│   知识图谱 / 知识星系 / 照片地图 · 资料上传 · 图谱与缺口接口 │
├─────────────────────────────────────────────────────────────┤
│ agent 业务层            packages/agent                       │
│   两种模式：field-qa（只读问答） / knowledge-build（写入审核）│
│   工具注册 + 系统提示词                                      │
├─────────────────────────────────────────────────────────────┤
│ 知识层                  packages/georag                      │
│   GeoRAG 三路检索 · 空间查询 · 不可变知识事件日志            │
├─────────────────────────────────────────────────────────────┤
│ 运行时                  vendor/runtime                       │
│   会话、模型调用、工具执行、Web 宿主（不对外暴露业务语义）   │
└─────────────────────────────────────────────────────────────┘
```

`config/wenshan.yml` 是产品挂载层：它把 `packages/georag` 与 `packages/intake` 挂到运行时上，并把 `agents/` 声明为可选的 agent 模式目录。`scripts/run.mjs` 负责替换其中的插件占位符，再以 `--patch` 启动运行时。

## 两种模式与工具权限

`packages/agent/src/index.js` 按 `mode` 只注册该模式允许的工具：

| 模式 | 工具 | 权限 |
| --- | --- | --- |
| `qa`（野外助教） | `retrieve` `read_note` `neighbors` `locate` `weather` `itinerary` + `report_knowledge_gap` | 只读知识库；只能登记缺口 |
| `build`（知识演化） | 上述只读 6 个 + `capture_source_text` `list_sources` `read_source` `create_knowledge_draft` `list_knowledge_drafts` `review_knowledge_draft` `publish_knowledge_draft` `reject_knowledge_draft` + `list_knowledge_gaps` `resolve_knowledge_gap` | 可收录、草稿、发布、销缺口 |

发布门禁在存储层强制：`publish_knowledge_draft` 必须收到原样的 `确认发布 draft-xxxxxxxx`，普通确认词一律拒绝。

## 检索

`packages/georag/src/engine.js` 是纯 ESM、零依赖实现，页面脚本与评测脚本共用同一份：

1. 词法：中文二元组 + ASCII 词 BM25（k1=1.2, b=0.75）。
2. 图谱：问句中的节点标题与地名解析结果为种子，双向 wikilink 两跳扩展，权重 1 / 0.55 / 0.28。
3. 空间：地名识别出锚点后按 `exp(-d/500)` 衰减；问句含「脚下/附近」且已知用户坐标时提高空间权重。

三路按 `lex 1.0 / graph 0.5 / spatial 0.6` 融合，再做意图加权（「讲了什么」偏向讲解点，「是什么/成因」偏向概念与主线），每篇笔记至多取 2 块。

## 知识生命周期

```text
资料（SHA-256 去重）→ 提取文本 → 草稿（待审核）→ 用户确认口令 → 发布
                                        ↘ 驳回（保留审计）
野外助教答不上来 → 登记缺口 → 补资料 → 发布 → 逐条销缺口
```

事实源是 `data/knowledge/events.jsonl`（append-only）。启动时重放事件得到增量节点，与只读的 `data/graph_data.json` 合并后构建引擎；因此基础数据重新生成不会覆盖人工审核成果。事件类型：`source.imported`、`source.reprocessed`、`draft.created`、`draft.rejected`、`draft.published`、`gap.reported`、`gap.resolved`。

节点 id 由 `标题 + 类型` 派生（`learned-<hash>`），发布时按标题覆盖旧版本并递增 revision。

## 数据文件

`scripts/build_data.py` 从 GDB、Obsidian 库与每日整理目录编译 `data/*.json`：

| 文件 | 内容 |
| --- | --- |
| `site_data.json` | 站点文案、示例问题、类型配色、统计 |
| `graph_data.json` | `{ nodes: [...] }`，节点含 `id/k/t/out/md/c/date/day/n`，`out` 即出边标题 |
| `days_data.json` | 每日行程、讲解点（坐标/时刻/场所/照片）、气象实测与 P–H 拟合 |
| `map_data.json` | 边界、水系、道路、地质、断层、土壤、植被、山峰、地点等图层 |
| `photos_index.json` | 照片 id → 说明/时刻 |
| `terrain.json` + `terrain.png` | 地形晕渲底图的元数据与位图（`scripts/build_terrain.py` 生成） |

## 页面路由

| 路由 | 页面 |
| --- | --- |
| `/` | 运行时主界面（`packages/intake` 注入主题样式与悬浮入口） |
| `/wenshan/knowledge-graph` | 2D 知识图谱（搜索、筛选、拖拽、缺口面板） |
| `/wenshan/knowledge-galaxy` | 3D 知识星系 |
| `/wenshan/photo-map` | 照片地图（自绘投影 + 地形底图 + 路线回放） |
| `/wenshan/api/evolution/*` | 图谱、节点、来源、缺口接口 |
| `/wenshan/api/photo-map` | 照片地图数据 |

## 测试与验收

- `tests/store.test.mjs`：知识事件日志的写入与重放，零外部依赖。
- `tests/smoke.test.mjs`：真实运行时上下文里注册工具并逐个执行。
- `tests/product.test.mjs`：来源→草稿→确认门禁→发布热更新→重放→只读隔离→缺口闭环→照片地图数据。
- `scripts/eval_qa.mjs`：152 题检索消融评测，产出 `docs/evaluation/`。
- `scripts/preflight.ps1`：构建、配置校验、挂载校验、冒烟与产品链路测试。

后两者依赖已构建的运行时（先跑 `scripts/install.bat`）。
