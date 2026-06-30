#!/usr/bin/env bash
# Investing Together — one-command deploy.
# Pulls the branch, installs deps, builds, migrates, syncs infra config, restarts services.
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
npm ci
npm run build
npm run migrate

# Sync systemd units + Caddy config from the repo (source of truth).
install -m 644 deploy/it-v1.service /etc/systemd/system/it-v1.service
install -m 644 deploy/it-v1-worker.service /etc/systemd/system/it-v1-worker.service
install -m 644 deploy/it-v1-monitor.service /etc/systemd/system/it-v1-monitor.service
install -m 644 deploy/it-v1-monitor.timer /etc/systemd/system/it-v1-monitor.timer
install -m 644 deploy/it-v1-filings.service /etc/systemd/system/it-v1-filings.service
install -m 644 deploy/it-v1-filings.timer /etc/systemd/system/it-v1-filings.timer
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl restart it-v1 it-v1-worker
systemctl enable --now it-v1-monitor.timer
systemctl enable --now it-v1-filings.timer
systemctl reload caddy

for _ in $(seq 1 20); do
  curl -sf -o /dev/null http://localhost:3000/ && break || sleep 1
done
echo "deployed — it-v1=$(systemctl is-active it-v1) worker=$(systemctl is-active it-v1-worker) caddy=$(systemctl is-active caddy)"
