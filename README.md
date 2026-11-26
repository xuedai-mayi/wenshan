# 问山（Wenshan）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

问山是一个面向地理野外实习的自成长知识图谱智能体。它把实习资料整理成可审核、可追溯的知识图谱，再用已发布的知识完成现场导览、教学讲解和问答；答不上来的问题会被登记为知识缺口，成为下一轮补资料的依据。

仓库自带完整运行时和全部业务组件：安装脚本会在本机构建运行时，克隆后即可启动一个可离线使用的独立智能体服务。

![问山主界面](docs/images/home.png)

## 架构

```text
packages/intake     页面与 HTTP 接口：知识图谱 / 知识星系 / 照片地图、资料上传、图谱与缺口接口
packages/agent      agent 业务层：野外助教（只读）与知识演化（写入审核）两种模式的工具与提示词
packages/georag     知识层：GeoRAG 三路检索、空间查询、不可变知识事件日志
vendor/runtime      内置运行时：会话、模型调用、工具执行、Web 宿主
config/wenshan.yml  产品挂载层：把上述组件装配成一个产品
agents/             两个 agent 模式的配置
```

两种模式共享同一份已发布知识，但工具权限严格隔离：知识演化模式可以收录资料、创建草稿、确认发布；野外助教模式只有只读检索工具和登记知识缺口的权限。细节见 [docs/architecture.md](docs/architecture.md)。

## 功能

- 知识演化：收录文字、PDF、Word、图片、录音和常见 GIS 文件，生成知识草稿，人工确认后再发布。
- 野外助教：只读正式知识库，支持概念检索、邻接关系、位置、气象和行程查询。
- 知识缺口闭环：野外助教答不上来的问题自动登记为缺口待办，知识演化模式按被问次数补资料、发布后逐条销掉。
- 照片地图：实习照片按讲解点聚簇落在真实地形晕渲底图上，支持逐日路线动画与"回放全程"时空演绎。
- 知识星系：知识图谱的三维星系视图，节点按类型发光、关联线粒子流动，可旋转、聚焦并阅读节点正文。
- 可交互图谱：搜索、筛选、拖动和定位节点，按需读取笔记正文。
- 本地持久化：原始资料、提取结果、草稿、发布记录、缺口记录分开保存，重启后可恢复。
- 权限隔离：野外助教没有资料写入和知识发布工具，只能登记缺口。

![知识图谱页面：252 个节点、1657 条关联，按类型配色，左侧搜索与类型筛选](docs/images/knowledge-graph.png)

## 运行环境

- Node.js 22.19 及以上（推荐 24）
- pnpm（只在安装阶段用，`npm install -g pnpm`）
- Python 3.11（可选，用于 PDF / Word / 录音 / GIS 提取与数据重建；纯文本问答与图谱页面不需要）

Windows、macOS、Linux 走同一条路径：只有一个入口 `wenshan`（`bin/wenshan.mjs`，通过 `package.json` 的 `bin` 暴露）。没有平台专用脚本，也不需要双击批处理——Windows 上同样在 PowerShell / cmd 里敲 `npm start` 或 `wenshan`。

几个由启动器自动处理、通常不用管的事：

| 机制 | 行为 |
| --- | --- |
| Python 探测 | `python3.11` → `py -3.11` → `python3` → `python`，可用 `WENSHAN_PYTHON=python3.12` 钉住 |
| Python 依赖 | 装在项目内 `.venv`，不碰系统环境（macOS 的 PEP 668 会挡住全局 pip） |
| 依赖分组 | `requirements-core`（必需）+ `audio` / `gis` / `tools`（缺轮子只降级对应格式） |
| 运行状态 | 写在项目内 `.wenshan-home`，不读也不写用户的 `~/.dsh`（可用 `WENSHAN_HOME` 改） |
| 端口 | 默认 `3080`，被其它服务占用时自动顺延并打印实际地址 |

## 快速开始

```bash
git clone <你的仓库地址>
cd <仓库目录>
npm start         # 首次运行会先问「现在安装？」，回车即可；也可先跑 npm run setup
```

想把它当成一个常驻命令（和 `claude`、`dsh` 一样从任何目录调用）：

```bash
npm link          # 把 bin 链接进全局 prefix
cd ~/任意目录
wenshan           # 起 web 服务，并在就绪后自动打开浏览器
```

敲 `wenshan` 不带子命令就等于 `wenshan start`：打印入口地址 → 等服务真正监听 → 用系统默认浏览器打开 http://127.0.0.1:3080/。CI、SSH 会话、无图形会话的 Linux 不会弹窗（只打印地址），也可以用 `--no-open` 或 `WENSHAN_OPEN=0` 关掉。

启动后终端会打印可用地址（默认 `3080`，被占用时自动顺延到下一个空闲端口）：

- 主界面：`http://127.0.0.1:3080/`
- 知识图谱：`http://127.0.0.1:3080/wenshan/knowledge-graph`
- 照片地图：`http://127.0.0.1:3080/wenshan/photo-map`（照片缩略图由 `npm run data` 生成）
- 知识星系：`http://127.0.0.1:3080/wenshan/knowledge-galaxy`

常用命令：

| 命令 | 作用 |
| --- | --- |
| `wenshan` / `wenshan start` | 启动 web 服务并在就绪后打开浏览器；缺依赖时引导安装 |
| `npm start` | 同上（仓库内的等价写法，首次运行会先询问是否安装） |
| `npm run setup` | 安装 / 修复依赖（幂等，`--force` 重跑） |
| `npm run doctor` | 环境体检：Node、pnpm、Python、运行时、页面依赖、数据、端口、挂载层 |
| `npm run data` | 从原始资料重建 `data/*.json` |
| `npm run terrain` | 生成地形晕渲底图 |
| `npm run eval` | 152 题检索消融评测 |
| `npm test` | 测试（运行时未构建时自动跳过集成测试） |
| `npm run preflight` | 发布前自检：体检 + 测试 + 挂载层校验 |

`npm run <命令>` 与 `wenshan <命令>` 完全等价（npm script 只是 `node bin/wenshan.mjs` 的别名），全局链接后不再需要 `npm run` 前缀。

启动参数透传给运行时自己的参数解析：

```bash
npm start -- --port 3081                      # 换端口
npm start -- --host 127.0.0.1 --port 0        # 让系统分配端口
npm start -- --dry-run                        # 只打印渲染后的挂载层与启动命令
wenshan start --port 3081                     # 换端口（全局命令下直接传，无需 --）
wenshan --no-open                             # 只起服务，不打开浏览器
```

依赖装了哪几组、缺哪几组，`npm run doctor` 会逐项列出；缺录音 / GIS 时该格式的上传只会降级，不影响文本与文档。

照片地图的地形晕渲底图由 `npm run terrain` 生成（从 AWS 开放高程瓦片下载 DEM，一次生成后离线可用；缺失时页面自动退回纯矢量底图）。

首次进入主界面后，在 `设置 > 模型` 中配置模型和 API Key。凭据写入本机配置，不进入本仓库。

## 使用流程

### 收录资料

切换到 `知识演化`，选择一个资料文件夹，或直接粘贴短文本。系统按 SHA-256 内容指纹去重，原件和提取结果会分别保存。

支持的主要格式：

| 类型 | 格式 |
| --- | --- |
| 文字 | TXT、Markdown、CSV、TSV |
| 文档 | PDF、DOCX |
| 图片 | JPG、PNG、WebP、HEIC、TIFF |
| 录音 | MP3、WAV、M4A、OGG、FLAC、AAC |
| GIS | GeoJSON、GPX、包含 Shapefile 或 GDB 的 ZIP |

### 审核并发布

发送 `处理最新资料` 后，知识演化引擎会读取来源并生成草稿。草稿不会自动进入正式知识库。确认内容无误后，按页面提示发送完整口令：

```text
确认发布 draft-xxxxxxxx
```

`可以`、`继续` 等普通回复不会触发发布。发布成功后，检索引擎会立即更新。

### 现场问答

切换到 `野外助教` 即可使用正式知识库。这个模式只注册读取工具，不能修改来源、草稿或已发布知识。

### 知识缺口闭环

野外助教确认"已发布实习资料中未覆盖此问题"后，会把问题原话登记为知识缺口；同一问题重复被问只累计次数。待补清单出现在知识图谱页左侧"待补充问题"面板，也可以在 `知识演化` 对话中发送 `查看知识缺口` 查看。补充资料并发布后，让知识演化引擎逐条销掉对应缺口。

## 数据结构

基础庐山数据位于 `data/*.json`。运行期间新增的资料和知识写入 `data/knowledge/`：

```text
data/knowledge/
├─ events.jsonl
├─ sources/
├─ extracted/
└─ structured/
```

`data/knowledge/`、`data/photos/`、`.venv/`、`.wenshan-home/` 和本机凭据都已经加入 `.gitignore`。运行状态（会话、凭据、profile 层）落在 `.wenshan-home/`，删掉即重置。公开仓库前仍应检查原始实习记录、照片和地理数据的授权与隐私边界。

如需从原始 GDB、Obsidian 知识库和每日整理目录重建基础数据，先修改 `config/lushan.json` 中的三个来源路径，再运行：

```bash
npm run data                                   # 默认 config/lushan.json
npm run data -- config/other-site.json         # 换一个实习区
```

## 项目结构

```text
bin/wenshan.mjs          统一命令行入口（start / setup / doctor / data / terrain / eval / test / preflight）
config/                  站点配置与产品挂载配置
  lushan.json            庐山站点配置（数据源路径、图层映射、文案）
  wenshan.yml            产品挂载层
agents/                  两种 agent 模式
  field-qa/              野外助教（只读问答）
  knowledge-build/       知识演化（写入审核）
packages/
  georag/                GeoRAG 检索、空间查询、知识事件存储
  agent/                 工具注册与两种模式的系统提示词
  intake/                资料收录、HTTP 接口与图谱/地图/星系页面
scripts/                 安装、启动、数据构建、评测与发布检查脚本
  lib/                   命令行实现：环境探测、挂载层渲染、安装、启动
tests/                   存储、冒烟、产品链路与浏览器验收测试
docs/                    架构文档、评测报告与图表、界面截图
data/                    可公开的基础检索数据
vendor/runtime/          随仓库分发的 agent 运行时源码
```

## 开发与测试

```bash
npm test                  # 知识事件日志的写入与重放 + 命令行层（零外部依赖）
npm run test:integration  # 冒烟 + 产品链路（需要先构建运行时）
npm run eval              # 152 题检索消融评测，写 docs/evaluation/
npm run preflight         # 跨平台发布自检：体检 + 测试 + 挂载层校验
```

评测报告见 [docs/evaluation/eval_report.md](docs/evaluation/eval_report.md)。

## 技术说明

问山自带运行时：会话、模型调用、工具执行、Web 界面与业务组件在安装后共同组成一个本机独立服务。图谱使用 `force-graph`，基础检索结合中文二元组 BM25、知识关系扩展和空间距离衰减。主服务只监听 `127.0.0.1`，适合本机演示和教学环境。

如需部署到公网，应另外配置登录鉴权、HTTPS、限流、文件安全检查和数据备份，不能直接暴露本机服务端口。

## 许可与声明

本项目使用 [MIT License](LICENSE)。随仓库分发的运行时源码及其第三方依赖同样以 MIT 许可分发，原始版权声明、许可文本和第三方依赖声明保留在随包源码目录内，汇总信息见 [NOTICE.md](NOTICE.md)。`force-graph` 使用 MIT 许可证。

山谷背景由本项目生成，仓库不包含原 Wallpaper Engine 素材包。公开使用庐山示例数据之前，请自行确认数据授权和隐私边界。
