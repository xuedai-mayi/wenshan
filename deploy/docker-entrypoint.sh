#!/usr/bin/env bash
# 问山 · 容器入口：把环境变量翻译成启动参数，再交给统一命令行入口。
#
#   PORT=3080                       容器内监听端口
#   WENSHAN_TRUSTED_HOSTS=a,b       反向代理用域名时，加进浏览器信任栅栏
#   WENSHAN_HOME=/app/.wenshan-home 运行状态目录（已在镜像里建好）
set -euo pipefail

args=(--no-open --host 0.0.0.0 --port "${PORT:-3080}")

if [[ -n "${WENSHAN_TRUSTED_HOSTS:-}" ]]; then
  IFS=',' read -r -a hosts <<< "${WENSHAN_TRUSTED_HOSTS}"
  for host in "${hosts[@]}"; do
    host="${host// /}"
    [[ -n "$host" ]] && args+=(--trusted-host "$host")
  done
fi

# 额外参数（同 docker run ... wenshan <args>）：直接透传给运行时。
exec node bin/wenshan.mjs start "${args[@]}" "$@"
