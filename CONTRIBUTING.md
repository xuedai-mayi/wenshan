# 参与贡献

感谢你愿意把时间花在问山上。这个仓库的规矩不多，但都写在测试里，先读再改。

## 开发环境

```bash
git clone https://github.com/xuedai-mayi/wenshan.git && cd wenshan
npm install -g pnpm
npm run setup          # 构建内置运行时 + 页面依赖 + Python 提取链
npm run doctor         # 缺什么会直接说
npm test               # 零依赖：存储、CLI、运维层
npm run test:integration
```

Node 22.19+；Python 3.11 只在处理文档/录音/GIS 时需要。

## 目录约定

| 目录 | 放什么 | 不放什么 |
| --- | --- | --- |
| `packages/georag` | 检索、空间查询、知识事件存储 | 页面、HTTP 路由 |
| `packages/agent` | 工具注册与两种模式的提示词 | 存储实现 |
| `packages/intake` | HTTP 接口与三个页面 | 检索算法 |
| `scripts/lib` | 安装、启动、体检、运维命令 | 业务语义 |
| `runtime` | 随包分发的运行时快照 | 业务代码（改这里等于改上游） |
| `agents/` | 两种模式的 preset | 工具实现 |

三条硬约束：

0. **运行时的插件标识不要改**：`agents/*/agent.cordis.yml` 里的 `name` 是内置运行时的插件契约（如 persona 插件），改了就加载不到；产品层要改名只能改业务包的包名与路径，不能改运行时内部标识。

1. **工具权限按模式注册**：野外助教只读 + 登记缺口；知识演化才可写。不要把写工具加进只读模式。
2. **发布门禁在存储层**：必须收到完整口令 `确认发布 draft-xxxxxxxx`。不要在提示词或 UI 层"优化"掉它。

## 提交流程

1. 开 issue 说清场景（bug 给复现步骤与 `npm run doctor` 输出）。
2. 从 `main` 拉分支，改动尽量小、单一目的。
3. 提交前跑：

```bash
npm test
npm run test:integration     # 改了 packages/ 或 scripts/ 必跑
npm run preflight            # 发版前必跑
```

4. 提交信息用 `type(scope): 中文摘要`，例如 `fix(intake): 上传同名资料时保留相对路径`。
5. PR 描述写：改了什么、为什么、怎么验证、有什么风险。

## 加一条新实习线

- 复制 `config/lushan.json` 为 `config/<site>.json`，改数据源与图层映射；
- `npm run data -- config/<site>.json` 重建数据；
- 不要提交原始 GDB、照片与受版权保护的底图。

## 不接受的改动

- 把状态目录写回用户主目录或系统目录；
- 引入需要联网才能启动的运行时依赖；
- 绕过草稿审核、自动发布；
- 在仓库里提交真实凭据、学生照片、未授权的第三方素材。

## 许可

提交即表示同意以仓库根目录的 MIT 许可分发你的贡献。
