# 变更日志

本文件记录问山的对外变更。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：
破坏性变更升主版本，向后兼容的新能力升次版本，修复与文档升修订号。

## 1.0.0 — 2026-11-26

**第一个可交付的产品版本：从「能跑的仓库」变成「能装、能运维、能交付的产品」。**

### 新增 · 可运维

- `wenshan backup` / `npm run backup`：把知识库与运行状态打成自描述归档；清单含路径、大小、权限与 SHA-256，`--data-only` 可排除模型凭据；归档文件默认 600、备份目录 700。
- `wenshan restore` / `npm run restore`：恢复前自动给现状留副本；路径白名单只允许 `data/knowledge/` 与 `.wenshan-home/`，篡改或路径穿越整体拒绝；支持 `--dry-run`。
- `wenshan health` / `GET /wenshan/api/health`：聚合计数的健康探针（资料数、待审草稿、已发布节点、缺口、运行时长、缺失数据文件），无正文、无路径、无凭据；`--json` 供脚本使用。
- 备份/恢复/健康三条命令进入统一 CLI 与 npm scripts，并新增 `tests/ops.test.mjs` 覆盖归档白名单、恢复闭环、篡改拒绝与探活归一。

### 新增 · 可部署

- `Dockerfile` + `docker-compose.yml`：预装内置运行时与 Python 提取链，具名卷保存知识库/运行状态/备份，镜像自带 `HEALTHCHECK`。
- `deploy/Caddyfile`：TLS、登录口令、请求体积限制、SSE 不缓冲、安全响应头与访问日志。
- `deploy/wenshan.service`：systemd 单元，最小权限（`ProtectSystem=strict` + 精确 `ReadWritePaths`）、崩溃重启。
- `deploy/wenshan-backup.sh` + `.service` + `.timer`：每日自动备份与保留 14 份的轮转。
- `docs/deploy.md`：本机 / 内网 / 公网 / 容器四条路径、升级回滚、观测与上线安全清单。

### 新增 · 可发布

- `.github/workflows/ci.yml`：零依赖单测快检 + 全链路（安装 → 集成测试 → 体检）。
- `.github/workflows/release.yml`：tag 触发，校验版本号与 tag 一致、构建镜像并冒烟 `/wenshan/api/health`、产出源码包与 SHA-256 并建 Release。
- `.dockerignore`、`backups/` 入 `.gitignore`。

### 新增 · 可交付

- `docs/product/PRD.md`：定位、用户、场景、能力矩阵、竞品对比、指标、交付形态与路线图。
- `docs/product/user-guide.md`：教师与学生的完整操作手册（安装 → 配置 → 收录 → 审核发布 → 问答 → 缺口 → 备份 → 换线）。
- `docs/product/faq.md`：安装、隐私、抽取稳定性、多人使用、部署与评测的可查答案。
- `site/index.html`：产品落地页（桌面 Web 优先）。
- `SECURITY.md`、`PRIVACY.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SUPPORT.md`。

### 变更

- 版本从 0.2.0 升至 1.0.0，`package.json` 补齐 keywords / homepage / bugs / 运维脚本。
- 明确平台范围：1.0 只面向桌面 Web（≥1280×800），移动端适配与原生能力不进本版本。
- 仓库更名为 `wenshan`（原 `dsh-wenshan`）；内置运行时目录从 `vendor/runtime/` 移到 `runtime/`。
- 产品层与上游运行时解耦：业务包不再声明上游包级依赖，启动器只为本进程设置运行时状态变量、
  不继承宿主值；产品代码与文档不再出现上游名称。三个业务包版本同步到 1.0.0。
- README 改版为产品首页：定位、能力、三种交付方式、文档地图。

## 0.2.0 — 2026-11-26

- 跨平台统一 CLI：`wenshan` 单入口取代平台脚本，`npm run <cmd>` 与其等价。
- 上传即构建：资料落库后自动分块抽取七类节点、与基础图谱对账、产出待审草稿。
- 知识缺口闭环：未覆盖问题登记、按被问次数排序、补料发布后销账。
- 照片地图与三维知识星系。
- GeoRAG 152 题消融评测报告与图表。
- 运行时隔离：状态目录固定在项目内 `.wenshan-home/`，不读写系统里其它服务的状态目录。

## 0.1.0

- 首发：知识图谱 / 野外助教 / 知识演化三种视图，GeoRAG 三路检索，不可变知识事件日志，发布口令门禁。
