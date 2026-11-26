# 问山 · 容器镜像
#
# 构建：docker build -t wenshan:1.0.0 .
# 运行：docker run --rm -p 127.0.0.1:3080:3080 \
#         -v wenshan-data:/app/data/knowledge \
#         -v wenshan-home:/app/.wenshan-home wenshan:1.0.0
#
# 镜像里预装内置运行时与 Python 提取链（文档 + GIS；录音转写体积大，按需自行安装），
# 因此首次启动不需要联网，也不会在容器里再跑一次安装。

FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WENSHAN_OPEN=0 \
    NODE_ENV=production

# python3（bookworm 自带 3.11）提供 PDF/DOCX 与 GIS 提取；tini 负责信号回收。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-dev build-essential \
        ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# 运行时用 pnpm 工作区构建，版本与 runtime/package.json 的 packageManager 对齐。
RUN npm install -g pnpm@11.7.0

WORKDIR /app

# 先复制清单与源码：依赖安装缓存只跟这些文件走。
COPY package.json ./
COPY bin ./bin
COPY scripts ./scripts
COPY config ./config
COPY agents ./agents
COPY packages ./packages
COPY runtime ./runtime
COPY data ./data
COPY deploy/docker-entrypoint.sh /usr/local/bin/wenshan-entrypoint
COPY README.md LICENSE NOTICE.md ./

# 安装：构建内置运行时 + 页面依赖 + 项目内 .venv（音频组默认跳过，见 requirements 说明）。
RUN chmod 0755 /usr/local/bin/wenshan-entrypoint \
    && npm run setup -- --yes \
    && rm -rf /tmp/* \
    && mkdir -p /app/data/knowledge /app/.wenshan-home \
    && chown -R node:node /app/data /app/.wenshan-home /app/packages

USER node

EXPOSE 3080

# 探针与 docker-compose / systemd 共用同一个接口：/wenshan/api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3080)+'/wenshan/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/wenshan-entrypoint"]
CMD []
