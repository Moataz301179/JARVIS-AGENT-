#!/usr/bin/env bash
set -euo pipefail

# Direct VPS installation: no Docker, database server, or PM2 required.
if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo ./deploy/install-systemd.sh" >&2
  exit 1
fi

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
APP_DIR="${APP_DIR:-/opt/jarvis}"
DATA_DIR="/var/lib/jarvis"
ENV_DIR="/etc/jarvis"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "Node.js 18+ is required on the VPS before installing Jarvis." >&2
  exit 1
fi
if ! "$NODE_BIN" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"; then
  echo "Node.js 18+ is required; found $($NODE_BIN --version)." >&2
  exit 1
fi

id -u jarvis >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin jarvis
install -d -o jarvis -g jarvis -m 0750 "$APP_DIR" "$DATA_DIR" "$ENV_DIR"
tar --exclude=.git --exclude=data --exclude=.env --exclude=dist -C "$SOURCE_DIR" -cf - . | tar -C "$APP_DIR" -xf -
chown -R jarvis:jarvis "$APP_DIR" "$DATA_DIR"

if [ ! -f "$ENV_DIR/jarvis.env" ]; then
  TOKEN="$($NODE_BIN -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  cat > "$ENV_DIR/jarvis.env" <<EOF
PORT=8080
DATA_DIR=$DATA_DIR
CHECK_INTERVAL_MS=60000
JARVIS_OPERATOR_TOKEN=$TOKEN
ALLOW_RECOVERY_ACTIONS=false
EOF
  chmod 0640 "$ENV_DIR/jarvis.env"
  chown root:jarvis "$ENV_DIR/jarvis.env"
fi

sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__NODE_BIN__|$NODE_BIN|g" "$APP_DIR/deploy/jarvis.service.template" > /etc/systemd/system/jarvis.service
systemctl daemon-reload
systemctl enable --now jarvis.service
sleep 1
systemctl --no-pager --full status jarvis.service
curl --fail --silent --show-error "http://127.0.0.1:8080/__health"
echo
echo "Jarvis is running. Add real health URLs and notification settings to $ENV_DIR/jarvis.env, then run: systemctl restart jarvis"
