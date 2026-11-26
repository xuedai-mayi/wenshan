#!/usr/bin/env bash
# 问山 · 定时备份（systemd timer 调用；cron 也能直接用）
#
#   sudo install -m 0755 deploy/wenshan-backup.sh /usr/local/bin/wenshan-backup
#   sudo mkdir -p /var/backups/wenshan && sudo chown wenshan:wenshan /var/backups/wenshan
#   sudo systemctl enable --now wenshan-backup.timer
#
# 归档默认包含 .wenshan-home（模型凭据），所以目录权限必须是 700，别放公共盘。

set -euo pipefail

APP_DIR="${WENSHAN_APP_DIR:-/opt/wenshan}"
BACKUP_DIR="${WENSHAN_BACKUP_DIR:-/var/backups/wenshan}"
RETAIN="${WENSHAN_BACKUP_RETAIN:-14}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

cd "$APP_DIR"
"$NODE_BIN" bin/wenshan.mjs backup "$BACKUP_DIR"

# 只保留最近 N 份：按文件名里的时间戳排序，旧的删掉。
mapfile -t archives < <(find "$BACKUP_DIR" -maxdepth 1 -name 'wenshan-backup-*.wenshan.gz' -type f | sort)
count=${#archives[@]}
if (( count > RETAIN )); then
  for stale in "${archives[@]:0:count-RETAIN}"; do
    rm -f -- "$stale"
    echo "已清理旧备份：$stale"
  done
fi

echo "备份完成：${archives[-1]:-无}"
