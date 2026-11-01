#!/bin/bash
# Ubuntu fallback when the official Docker registry cannot be reached.
# Installs only the loopback application; DNS, public ports and HTTPS stay separate.
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run on the ECS server as root.' >&2; exit 1; }
archive=${1:?Usage: setup-native.sh release.tar.gz expected-sha256}
expected=${2:?Expected deployment archive SHA-256 is required}
test "$(sha256sum "$archive" | cut -d ' ' -f 1)" = "$expected" || { echo 'Archive checksum mismatch' >&2; exit 1; }
test "$(uname -m)" = x86_64
test ! -e /etc/systemd/system/yuantuo-finance.service || { echo 'Existing deployment found; use the documented backup-and-upgrade procedure.' >&2; exit 1; }

version=24.22.0
runtime="/opt/yuantuo-node/$version"
release="/opt/yuantuo-finance/releases/20261017"
install -d -m 0755 /opt/yuantuo-node /opt/yuantuo-finance/releases
download=$(mktemp -d /var/tmp/yuantuo-node.XXXXXX)
curl --proto '=https' --tlsv1.2 -fL --retry 2 --connect-timeout 15 --max-time 600 "https://nodejs.org/dist/v$version/node-v$version-linux-x64.tar.xz" -o "$download/node-v$version-linux-x64.tar.xz"
curl --proto '=https' --tlsv1.2 -fL --retry 2 --connect-timeout 15 --max-time 60 "https://nodejs.org/dist/v$version/SHASUMS256.txt" -o "$download/SHASUMS256.txt"
(cd "$download"; awk -v f="node-v$version-linux-x64.tar.xz" '$2 == f' SHASUMS256.txt > selected.sha256; test -s selected.sha256; sha256sum -c selected.sha256)
install -d -m 0755 "$runtime" "$release"
tar -xJf "$download/node-v$version-linux-x64.tar.xz" --strip-components=1 -C "$runtime"
tar -xzf "$archive" --no-same-owner -C "$release"
ln -s "$release" /opt/yuantuo-finance/current
id yuantuo >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/yuantuo-finance --shell /usr/sbin/nologin yuantuo
install -d -o yuantuo -g yuantuo -m 0700 /var/lib/yuantuo-finance /var/lib/yuantuo-finance/backups

cat > /etc/yuantuo-finance.env <<'ENV'
NODE_ENV=production
HOST=127.0.0.1
PORT=4318
APP_ORIGIN=https://finance.yuantuo.vip
DB_PATH=/var/lib/yuantuo-finance/finance.sqlite
TRUST_PROXY_IP=127.0.0.1
ENV
chmod 0600 /etc/yuantuo-finance.env
cat > /etc/systemd/system/yuantuo-finance.service <<'UNIT'
[Unit]
Description=Yuantuo Finance
After=network.target
[Service]
Type=simple
User=yuantuo
Group=yuantuo
WorkingDirectory=/opt/yuantuo-finance/current
EnvironmentFile=/etc/yuantuo-finance.env
ExecStart=/opt/yuantuo-node/24.22.0/bin/node server/start.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/yuantuo-finance
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
UNIT

install -d -m 0755 /opt/yuantuo-finance/bin
cat > /opt/yuantuo-finance/bin/backup <<'BACKUP'
#!/bin/sh
set -eu
stamp=$(date -u '+%Y%m%dT%H%M%SZ')
exec /opt/yuantuo-node/24.22.0/bin/node /opt/yuantuo-finance/current/server/backup.mjs backup /var/lib/yuantuo-finance/finance.sqlite "/var/lib/yuantuo-finance/backups/finance-$stamp.sqlite"
BACKUP
chmod 0755 /opt/yuantuo-finance/bin/backup
cat > /etc/systemd/system/yuantuo-finance-backup.service <<'UNIT'
[Unit]
Description=Yuantuo Finance consistent SQLite backup
After=yuantuo-finance.service
[Service]
Type=oneshot
User=yuantuo
Group=yuantuo
ExecStart=/opt/yuantuo-finance/bin/backup
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/yuantuo-finance
UNIT
cat > /etc/systemd/system/yuantuo-finance-backup.timer <<'UNIT'
[Unit]
Description=Yuantuo Finance daily backup
[Timer]
OnCalendar=*-*-* 03:05:00 Asia/Shanghai
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now yuantuo-finance.service
systemctl enable --now yuantuo-finance-backup.timer
echo 'Loopback application installed. Complete owner initialization interactively before public access.'
