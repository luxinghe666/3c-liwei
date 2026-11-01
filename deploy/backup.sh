#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
stamp=$(date -u '+%Y%m%dT%H%M%SZ')
docker compose exec -T app node server/backup.mjs backup /app/data/finance.sqlite "/app/backups/finance-$stamp.sqlite"
echo "已生成一致性备份 finance-$stamp.sqlite；请按部署方案复制到独立备份存储。"
