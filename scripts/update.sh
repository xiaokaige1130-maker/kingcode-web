#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

cd "$PROJECT_DIR"
git pull origin main
npm install
node --check server.js

if command -v pm2 >/dev/null 2>&1 && pm2 describe kingcode-web >/dev/null 2>&1; then
  pm2 restart kingcode-web
fi

curl -fsS "http://127.0.0.1:${PORT:-4780}/api/health" >/dev/null 2>&1 || true
echo "KingCode updated."
