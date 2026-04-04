#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

require_min_node() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -lt 18 ]; then
    echo "Node.js 版本过低：当前 $(node -v)，至少需要 v18。"
    exit 1
  fi
}

cd "$PROJECT_DIR"
require_min_node
git pull origin main
npm install
node --check server.js

if command -v pm2 >/dev/null 2>&1 && pm2 describe kingcode-web >/dev/null 2>&1; then
  pm2 restart kingcode-web
fi

curl -fsS "http://127.0.0.1:${PORT:-4780}/api/health" >/dev/null 2>&1 || true
echo "KingCode updated."
