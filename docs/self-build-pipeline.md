# 上传即构建：知识图谱自构建管线

目标：用户上传实习资料后，系统自动产出**待审核草稿**，人只做"审核 + 确认发布"两件事。

## 已经实现

| 环节 | 实现 | 位置 |
| --- | --- | --- |
| 上传后自动触发 | 响应先返回，构建在后台跑；正文 <200 字或提取失败时跳过 | `packages/intake/src/index.js`（`POST /wenshan/api/evolution/sources` 之后） |
| 分块 | 按标题层级与空行切，打包到 2500 字；超限等距抽样 | `packages/georag/src/build.js` `splitSource` / `capChunks` |
| 抽取 | **用「设置 > 模型」里当前选中的模型**，逐块调用 | 同上，`EXTRACT_SYSTEM` + `ctx.llm.stream` |
| 解析 | 容忍围栏/废话/尾随逗号；截断与坏 JSON 各重试一次 | 同上，`parseExtraction` |
| 校验合并 | 七类白名单、标题/正文长度、坐标范围、`1040m` 这类读数；同 (标题, 类型) 合并 | 同上，`normalizeItem` / `normalizeItems` / `mergeEdges` |
| 与基础图谱对账 | 同名同类不新建，归 `supplement` 交人工 | 同上，`reconcile` / `draftPayloads` |
| 落草稿 | `store.createDraft`，≤100 节点/份自动切分 | 同上 |
| 状态与重试 | `GET/POST /wenshan/api/evolution/build`，按 sourceId 幂等 | `packages/intake/src/index.js` |

## 实测数据（2026-11-26，deepseek-v4-flash）

一份 1582 字的庐山三日观察记录，一段一条调用：

| 资料 | 块数 | 耗时 | 抽出节点 | 入草稿 | 同名归 supplement |
| --- | --- | --- | --- | --- | --- |
| 319 字片段 | 1 | ~13 秒 | 7 | 5 | 2（芦林湖、庐山） |
| 1582 字 | 1 | 11—18 秒 | 13—22 | 13—18 | 7（锦绣谷、三叠泉、五老峰、含鄱口、鄱阳湖、芦林湖、仙人洞） |

一份 6076 字的记录切成 3 块并发生成，26 个节点、22 个入草稿，块级零失败。

**同一份资料两次跑出来的节点数会不一样（13 / 18）。** 抽取是生成式的，`temperature: 0.2` 只能压幅度、不能保证复现。所以草稿必须人审——这不是缺陷，是"发布前人工核对"这条设计成立的理由。

抽出来的样子（1582 字那次的最后一稿，14 个节点）：

```text
[气象] 《7月11日天气》            → 锦绣谷
[概念] 《重力崩塌》               → 锦绣谷 / 冰川成因证据与争议 / 流水地貌与重力地貌判别标志
[概念] 《地下水循环》             → 锦绣谷
[概念] 《物理风化》               → 仙人洞
[概念] 《阶梯状跌水》             → 三叠泉
[概念] 《流水搬运》               → 三叠泉 / 重力崩塌 / …
[概念] 《山地云雾》               → 五老峰 / 含鄱口
[概念] 《断块抬升》               → 含鄱口 / 鄱阳湖
[概念] 《壶穴》                   → 三叠泉
[概念] 《冰碛物》                 → 芦林湖 / 含鄱口 / …
[每日] 《7月11日行程观察》         → 锦绣谷 / 仙人洞 / 三叠泉 / 五老峰
[每日] 《7月12日行程观察》         → 含鄱口 / 三叠泉 / 芦林湖
[主线] 《冰川成因证据与争议》      → 冰碛物 / 流水搬运 / 重力崩塌
[概念] 《流水地貌与重力地貌判别标志》 → 冰碛物 / 流水搬运 / 重力崩塌
```

地名全部对账到已有节点（7 个同名归 supplement，一个都没重复新建），关系全部指向真实存在的标题。

## 关键决定：模型凭据不经过本插件

抽取用的是宿主已经挂好的模型调用服务，**不是**新配一套环境变量：

```js
const target = ctx.agentDefaultModel.currentSelection()   // 设置 > 模型 里选的那一路
ctx.llm.stream({ provider: target.provider, model: target.model, system, messages, maxTokens })
```

- 凭据由提供方适配器解析（API Key 走 credentials 服务，账号型走账号令牌），插件既不读 `.env`，也不读 `settings.yaml`，任何密钥都不会出现在本仓库的代码或日志里。
- 用户在「设置 > 模型」里换模型，下次上传就用新模型——不需要改配置、不需要重启。
- 两个服务都可能在插件之后才挂载，所以是**调用时懒解析**（`ctx.reflect.get(name, false)`），不是挂载时绑定。

没配 Key 时不会静默失败，状态里会明确写：

```json
{"state":"failed",
 "error":"llm-deepseek: no API key for provider route \"deepseek-official\"… ｜去「设置 > 模型」给 deepseek-official 填上 API Key 后重试"}
```

重试：`POST /wenshan/api/evolution/build {"sourceIds":["src-…"],"force":true}`。

联调时用 `DEEPSEEK_API_KEY=… npm start` 临时注入也行，但**正式用请在「设置 > 模型」里存**：那条路写进本机凭据存储（`.wenshan-home/.credentials.yaml`，600 权限、已被 `.gitignore` 挡住），进程重启不用再带环境变量，也不会留在 shell 历史里。

## 借用关系：cognee 是可选项，不再是必需

上一版把抽取交给 cognee（`cognify(graph_model=WenshanGraph)`），那条路要求模型凭据以 `LLM_API_KEY`/`LLM_ENDPOINT` 形式交给 Python 进程。**现在不需要了**：

| 能力 | 现在由谁做 | cognee 还需要吗 |
| --- | --- | --- |
| 分块 / 抽取 / 合并 / 增量 | 本仓库 `build.js`（自带，用宿主模型） | 不需要 |
| 图存储与写入事件 | `data/*.json` + `events.jsonl` | 不需要，也不该替换 |
| 语义召回（第四路） | 未实现 | **可选**：这时才要 cognee 的向量库，见 [cognee-integration.md](cognee-integration.md) |

`scripts/wenshan_kg_model.py` 与 `scripts/cognee_to_draft.py` 保留给"走 cognee 做抽取或语义索引"的路线，格式与 `build.js` 共用：

```json
{"sourceIds": ["src-…"], "label": "…",
 "items": [{"kind": "讲解点", "title": "…", "content": "…", "coordinate": [115.9, 29.5]}],
 "edges": [{"from": "…", "to": "…", "type": "解释"}]}
```

## 提示词的三条硬约束

`EXTRACT_SYSTEM` 里写死的规矩，和 `qaPrompt` 的"不得补来源外知识"是一条线：

1. 只抽取原文明确支持的内容，不得补充常识、不得推测。
2. 正文 20—800 字，保留原文数字、地名、坐标、海拔、时间。
3. 坐标只认原文给的经纬度，没给就省略，不得估算。

自动抽取最容易出的问题不是"抽少了"，而是"抽出了原文没有的因果"。前两条压这个，第三条压"编坐标"。

## 已实测的行为（`tests/build.test.mjs`，`npm test` 会跑）

- 分块：不丢字、单块不超上限、超限时等距抽样。
- 解析：围栏、前后废话、尾随逗号都能救；截断与无 JSON 会报错并触发重试。
- 校验：脏数据单条丢弃（记原因），不炸整份草稿；`1040m` 解析成 1040；坐标越界丢弃。
- 合并：同 (标题, 类型) 取更长正文、关系取并集；边补成双向 `relations`。
- 对账：基础图谱里已有的「芦林湖」（地点）不被新建；同名不同类允许并存。
- 分批：150 个节点切 2 份，单份 ≤100。
- 端到端（假模型，真 `KnowledgeStore`）：2 块 → 1 份草稿 / 2 节点，草稿 `sourceIds` 唯一指向该资料，状态 `drafted`，重复构建 `skipped`。
- 无模型服务 / 没选模型：返回可读错误，不抛异常。
- 真机：上传 → 后台触发 → 状态可查；没配 Key 时错误如实落在 `status()` 里（上面那段）。

## 推进过程中踩到的坑（都已在代码里处理）

### 1. 开思考会吃光输出预算

第一版按默认档位跑，同一份资料稳定失败。直接打 API 才看清：`max_tokens: 8000` 时 `completion_tokens_details.reasoning_tokens` 正好 8000，`content` 为空、`finish_reason: length`——**输出预算全被思考吃掉，一个字都没留给 JSON**。

修法：抽取调用显式关思考（`reasoningEffort: 'off'`，DeepSeek 适配器会翻成 `thinking: {type: 'disabled'}`）。关掉后同一份资料 18 秒返回 34 个节点、`finish_reason: stop`。写成 `'low'` 不够——低档位照样能把预算耗完。

另外两条兜底：被截断时从后往前找最后一个完整的 items 元素抢救（`salvageTruncated`），以及传输层失败重试一次。

### 2. 手搓 `{role:'assistant'}` 消息会崩

重试时我往消息列表里塞了一条手写的 assistant 消息（想复述上一次的坏输出）。运行时的 `forAdapter` 会读 `message.source.kind`，而手搓消息没有 `source` → `TypeError: Cannot read properties of undefined (reading 'kind')`。用户看到的是"全部 1 块都抽取失败"，日志里只有一行没有堆栈的错误。

修法：改用运行时的 `createUserMessage` 构造消息（它补齐 `id` 并把 `source` 冻结成合法形状），重试改成再追加一条 user 指令，不再伪造 assistant 消息。

### 3. 同名节点必须对账，且同名不同类也算冲突

`engine.js` 的 `titleToId` 按标题首见优先建索引。基础图谱里已有「芦林湖」（地点），模型却把它抽成「讲解点」——两个节点同名并存，检索结果里同时出现，《芦林湖》引用的到底是哪一个说不清。

所以三条规则：同名同类 → supplement（不新建）；同名不同类 → **冲突，也不新建**，在摘要和状态里点名；其余正常新建。实测这一条挡下了 7 个重复地名。

### 4. 悬空关系要剪掉

模型会给《7月12日行程》挂上《7月12日天气》，而后者这次没抽出来。草稿里留着这种关系，发布后就是一条指向空处的双链。现在只保留能解析到「本批节点 ∪ 已有图谱 ∪ supplement」的关系，其余丢弃并在摘要里报数。

## 另外两个实测出来的坑

1. **同名同类再发布 = 静默覆盖**。节点 id 是 `learned-<sha256(title + kind)>`，确定性生成。实测两份草稿发布同一标题后节点数仍是 1，正文变成后发那份。幂等是好事，但审核界面必须说明"这会替换已有正文"。想保留旧正文，需要给 `KnowledgeStore` 加 `node.supplemented` 事件（追加优先于覆盖，仍符合不可变日志）。
2. **块数要有上限**。一份 200 万字资料按 2500 字切是 800 块 = 800 次模型调用。`maxChunks` 默认 60，超了等距抽样并在日志里说明。

## 还能往下做的三件事

1. **审核界面**：`GET /wenshan/api/evolution/build` 的 `sources[*].state` 已经能驱动进度条；草稿列表接口还没有，`listDrafts` 只在 agent 工具里用。加一个 `GET /wenshan/api/evolution/drafts` 就能让"待审核 N 条"点得进去。
2. **补充语义**：见坑 1，`node.supplemented` 事件约 40 行 + 一个测试。
3. **语义召回**：要"换个说法也检索得到"，再接 cognee 的向量库做第四路（[cognee-integration.md](cognee-integration.md) 的 B 档）。
