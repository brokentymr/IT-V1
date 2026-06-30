#!/usr/bin/env bash
# Investing Together — one-command deploy (Phase 0).
# Pulls the branch, installs deps, builds, and restarts the systemd-managed app.
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
npm ci
npm run build

# Keep the installed unit in sync with the repo copy, then restart.
install -m 644 deploy/it-v1.service /etc/systemd/system/it-v1.service
systemctl daemon-reload
systemctl restart it-v1

# wait for readiness
for _ in $(seq 1 20); do
  curl -sf -o /dev/null http://localhost:3000/ && break || sleep 1
done
echo "deployed — it-v1.service is $(systemctl is-active it-v1), serving on :3000 (Caddy fronts :80)"
