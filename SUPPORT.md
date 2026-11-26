# 支持

## 先看这些

| 你想做的事 | 看这里 |
| --- | --- |
| 装起来、跑起来 | [README 快速开始](README.md#快速开始) |
| 教师/学生怎么用 | [用户手册](docs/product/user-guide.md) |
| 部署到服务器或公网 | [部署指南](docs/deploy.md) |
| 报错、行为不符合预期 | [FAQ](docs/product/faq.md) |
| 产品定位与路线图 | [PRD](docs/product/PRD.md) |

## 自助排查

```bash
npm run doctor      # 环境体检：Node / pnpm / Python / 运行时 / 数据 / 端口 / 挂载层
npm run health      # 服务是否活着
npm test            # 零依赖测试
```

提问时附上 `npm run doctor` 输出、操作系统与版本、复现步骤。**不要**贴 API Key、学生姓名、照片原图或未脱敏坐标。

## 渠道

| 类型 | 渠道 | 说明 |
| --- | --- | --- |
| Bug | GitHub Issues | 用模板，附 `doctor` 输出与复现步骤 |
| 功能建议 | GitHub Issues | 说清场景（谁、在什么环节、现在怎么绕） |
| 安全问题 | Security Advisories | 见 [SECURITY.md](SECURITY.md)，不要开公开 issue |
| 合作 / 私有化交付 | 仓库主页联系维护者 | 说明实习线、人数、部署环境 |

## 响应预期

这是教学场景的开源项目，维护者按可用时间处理：

- 安全问题：72 小时内确认；
- Bug：7 天内给出判断（可复现/需补充/不修）；
- 功能建议：进入路线图讨论，不承诺排期。

## 商业支持

私有化部署、数据构建与教师培训属于项目制服务范围，边界见 [PRD 的交付形态](docs/product/PRD.md#10-交付形态)。开源部分（MIT）不因是否购买服务而设限。
