# 问山 · 部署指南

> 面向要把问山交给一个团队使用的部署方。只在自己电脑上试用的读者看 [README 快速开始](../README.md#快速开始) 就够了。

## 先选路径

| 路径 | 适用 | 入口 | 鉴权 | 工作量 |
| --- | --- | --- | --- | --- |
| A 本机 | 一位教师、一台笔记本 | `127.0.0.1:3080` | 无（本机） | 5 分钟 |
| B 内网服务器 | 实习队 15—60 人、现场局域网 | 内网 IP + 反代 | 建议加口令 | 0.5—1 小时 |
| C 公网 | 行前备课、跨校区访问 | 域名 + HTTPS | 必须有 | 1—2 小时 |
| D 容器 | 已有 Docker 运维体系 | compose + 卷 | 同 B/C | 30 分钟 |

共同前提：Node 22.19+、pnpm；要处理 PDF / 录音 / GIS 再加 Python 3.11。内存建议 ≥ 4 GB，磁盘按资料量估（1000 张照片约 3—5 GB）。

---

## A. 本机（默认形态）

```bash
git clone https://github.com/xuedai-mayi/wenshan.git && cd wenshan
npm start            # 首次会问是否安装，回车即可
```

服务只监听 `127.0.0.1`，不做鉴权。适合个人备课与演示，**不要**把它绑到 `0.0.0.0` 后直接对外。

---

## B. 内网服务器（systemd）

### 1. 建用户与目录

```bash
sudo useradd --system --create-home --home-dir /var/lib/wenshan wenshan
sudo mkdir -p /opt/wenshan /var/backups/wenshan
sudo chown -R wenshan:wenshan /opt/wenshan /var/backups/wenshan
```

### 2. 放代码并安装

```bash
sudo -u wenshan git clone https://github.com/xuedai-mayi/wenshan.git /opt/wenshan
sudo -u wenshan bash -lc 'cd /opt/wenshan && npm run setup -- --yes'
sudo -u wenshan bash -lc 'cd /opt/wenshan && npm run doctor'
```

### 3. 装服务单元

```bash
sudo cp deploy/wenshan.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wenshan
journalctl -u wenshan -f
```

单元里已经做了：`WENSHAN_HOME=/var/lib/wenshan/home`、只监听 `127.0.0.1:3080`、`ProtectSystem=strict` 且只放开知识库与状态目录、崩溃自动重启。

### 4. 给队内加一个入口

内网也需要口令，免得谁扫到端口都能改知识库。最省事的是 Caddy（见下节），把域名换成内网名、`tls internal` 即可自签。

---

## C. 公网（Caddy + HTTPS）

### 1. 反向代理

编辑 `deploy/Caddyfile`：

1. 改域名与邮箱；
2. `caddy hash-password --plaintext '你的口令'` 生成哈希，粘到 `basic_auth` 里；
3. `sudo caddy validate --config deploy/Caddyfile` 后 `sudo caddy run --config deploy/Caddyfile`（或装成 caddy.service）。

Caddy 负责 TLS、登录、请求体积（210 MB）、安全响应头、SSE 不缓冲。应用仍然只听 `127.0.0.1`。

### 2. 让应用接受这个域名

运行时有一层浏览器信任栅栏：用域名访问 `/api` 时，需要显式声明受信任的 authority。

```bash
# 前台临时验证
wenshan start -- --trusted-host wenshan.example.com
```

systemd 下打开 `deploy/wenshan.service` 里注释的两行：

```ini
Environment=WENSHAN_DOMAIN=wenshan.example.com
ExecStart=/usr/bin/env node bin/wenshan.mjs start --no-open --host 127.0.0.1 --port 3080 -- --trusted-host ${WENSHAN_DOMAIN}
```

> 只加真正要用的域名，不要图省事写通配。

### 3. 验收

```bash
curl -fsS https://wenshan.example.com/wenshan/api/health | jq .
```

期望 `"status": "ok"`。浏览器打开首页，登录后能切换两种模式、能上传一份小文本，即通。

---

## D. 容器

```bash
docker compose up -d --build
docker compose logs -f wenshan
docker compose exec wenshan node bin/wenshan.mjs health
```

- 知识库、运行状态、备份各自一个具名卷；重建容器不丢数据。
- 默认只绑 `127.0.0.1:3080`，对外仍走 Caddy。
- 用域名反代时在 compose 里设 `WENSHAN_TRUSTED_HOSTS=wenshan.example.com`（逗号分隔多个）。
- 镜像自带 `HEALTHCHECK`，`docker ps` 会显示 healthy/unhealthy。

构建耗时主要在内置运行时与 Python 依赖；CI 的 `release.yml` 会在发布前跑一次容器冒烟。

---

## 备份、恢复、升级

### 备份

```bash
# 手动
wenshan backup /var/backups/wenshan

# 定时：装 systemd timer
sudo install -m 0755 deploy/wenshan-backup.sh /usr/local/bin/wenshan-backup
sudo cp deploy/wenshan-backup.service deploy/wenshan-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now wenshan-backup.timer
systemctl list-timers wenshan-backup.timer
```

备份内容 = 知识库 + 运行状态（含 API Key），归档带 SHA-256 与恢复前快照；默认保留 14 份。`wenshan backup` 会把归档写成 600、目录建成 700，别用别的工具搬动时把权限放开。

### 恢复

```bash
wenshan restore /var/backups/wenshan/wenshan-backup-20261126-032000.wenshan.gz --dry-run
wenshan restore /var/backups/wenshan/wenshan-backup-20261126-032000.wenshan.gz
sudo systemctl restart wenshan
```

恢复前会把现状复制成 `<目录>-restore-<时间戳>`；清单里出现白名单之外的路径会整体拒绝。

### 升级

```bash
wenshan backup                      # 1. 先备份
git -C /opt/wenshan pull            # 2. 拉代码
npm run setup -- --force            # 3. 重建内置运行时与依赖
npm run doctor && npm test          # 4. 体检 + 测试
sudo systemctl restart wenshan      # 5. 重启
```

知识事件是 append-only 的：重启时重放 `events.jsonl` 与基础数据合并，人工审核成果不会因为重建基础数据被覆盖。

### 回滚

代码回滚到上一个 tag 后重复升级的第 3—5 步；数据回滚用 `wenshan restore`。两者独立，不必一起做。

---

## 观测

| 项目 | 位置 |
| --- | --- |
| 进程存活 | `GET /wenshan/api/health`（200 = ok，503 = degraded） |
| 一行体检 | `wenshan health --url http://127.0.0.1:3080`，脚本用 `--json` |
| 服务日志 | `journalctl -u wenshan -f` 或 `docker compose logs -f` |
| 访问日志 | Caddy 写 `/var/log/caddy/wenshan-access.log`（JSON，20 MiB 滚动 5 份） |
| 知识状态 | 图谱页或 `GET /wenshan/api/evolution/status` |

`/wenshan/api/health` 只返回聚合计数（资料数、待审草稿、已发布节点、缺口数、运行时长、缺失数据文件），不含正文、路径与凭据，可以安全地被探针高频轮询。

---

## 安全清单（上线前逐条打勾）

- [ ] 应用只监听 `127.0.0.1`（`ss -lntp | grep 3080` 确认）
- [ ] 公网入口有 HTTPS，HTTP 自动跳转
- [ ] 有登录（Caddy basic_auth，或接入院系 SSO 的 forward_auth）
- [ ] `--trusted-host` 只列真实域名
- [ ] 请求体上限 ≤ 210 MB，与挂载层 `maxUploadBytes` 对齐
- [ ] 备份目录 700，且不在 Web 可达路径下
- [ ] `.wenshan-home/` 与 `data/knowledge/` 不在版本库内（`git status` 确认）
- [ ] 模型 API Key 只存在服务器本机，离职人员不留存
- [ ] 资料、照片、地图数据的授权与隐私边界已确认
- [ ] 至少演练过一次「备份 → 删库 → 恢复」

## 容量参考

| 场景 | 资料量 | 建议配置 |
| --- | --- | --- |
| 一条实习线、单教师 | 500 份文档 + 2000 张照片 | 2 vCPU / 4 GB / 20 GB |
| 一条线、全队并发 20 人问答 | 同上 | 4 vCPU / 8 GB / 40 GB |
| 多站点、教研室共用 | 3—5 条线 | 8 vCPU / 16 GB / 100 GB |

瓶颈通常在模型调用而不是本机 CPU：并发抽取默认 2，按提供方配额调 `config/wenshan.yml` 的 `build.concurrency`。
