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

`config/wenshan.yml` 是产品挂载层：它把 `packages/georag` 与 `packages/intake` 挂到运行时上，并把 `agents/` 声明为可选的 agent 模式目录。

挂载层是模板，五处占位符在启动时由 `scripts/lib/overlay.mjs` 注入本机真实值：两个插件入口、提取器路径、Python 解释器、解释器前置参数。注入值用 JSON 编码写入（JSON 字符串即 YAML 双引号标量），因此同一份配置在三个平台上通用，不需要 bat 里拼字符串，也不必为 Python 版本改配置。渲染结果写到系统临时目录，作为 `--patch` 交给运行时，进程退出即删除。

## 安装与启动

`bin/wenshan.mjs` 是唯一入口，通过 `package.json` 的 `bin` 暴露成 `wenshan` 命令；`npm run <cmd>` 只是它的别名。仓库里没有平台专用脚本。

| 层 | 职责 |
| --- | --- |
| `bin/wenshan.mjs` | 命令解析、`--help`、退出码 |
| `scripts/lib/detect.mjs` | Node / pnpm / Python 探测、端口可用性、已构建状态判定 |
| `scripts/lib/overlay.mjs` | 挂载层占位符渲染 |
| `scripts/lib/setup.mjs` | 幂等安装计划：构建运行时 → 页面依赖 → 提取依赖 → 挂载层校验 |
| `scripts/lib/launch.mjs` | 端口顺延、拉起运行时的 web 面、就绪后打开浏览器、信号与临时文件清理 |

启动器的默认命令是 `start`：敲 `wenshan` 即起 web 面，并等到端口真正监听后再用系统默认浏览器打开入口（`browserCommand` 按平台选 `open` / `cmd /c start` / `xdg-open`；CI、SSH、无图形会话自动跳过，`--no-open` 可强制关闭）。**就绪判定用端口探测而不是猜时间**，否则浏览器会先于服务到达。

启动器只做「准备环境 + 传参」两件事，业务语义仍然只存在于 `packages/` 里。启动路径与当前工作目录无关：状态、配置、相对路径都由 `import.meta.url` 推出的仓库根决定，子进程 `cwd` 也钉在仓库根，因此 `npm link` 之后从任意目录执行 `wenshan start` 行为一致。

两条隔离约定，写在这里免得以后又被"顺手"合回去：

- **运行时状态目录**：启动器把 `DSH_HOME` 指到项目内 `.wenshan-home/`（`WENSHAN_HOME` 可覆盖），并刻意不读继承来的 `DSH_HOME`。原因不只是整洁——内置运行时是随包分发的快照，可能比用户本机装的 dsh 旧，共享目录时旧快照会拒绝新版写出的 `credentials.yaml`，表现为「问山起不来」。
- **Python 环境**：提取与数据管线依赖装在项目内 `.venv/`，不写系统 site-packages；依赖按 `requirements-core / audio / gis / tools` 分组，缺轮子只降级对应格式。

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
- `tests/cli.test.mjs`：版本/解释器探测、挂载层渲染、端口顺延、安装状态判定，零外部依赖。
- `tests/smoke.test.mjs`：真实运行时上下文里注册工具并逐个执行。
- `tests/product.test.mjs`：来源→草稿→确认门禁→发布热更新→重放→只读隔离→缺口闭环→照片地图数据。
- `scripts/eval_qa.mjs`：152 题检索消融评测，产出 `docs/evaluation/`。

`npm test` 只跑零依赖的两个文件；`npm run test:integration` 与 `npm run eval` 依赖已构建的运行时（先跑 `npm run setup`）。`npm run preflight` 把体检、测试与挂载层校验串成一条跨平台命令。
