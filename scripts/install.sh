#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-git@github.com:xiaokaige1130-maker/omnicode-web.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/omnicode-web}"

command -v git >/dev/null 2>&1 || { echo "Missing dependency: git"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Missing dependency: node"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Missing dependency: npm"; exit 1; }

if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm install

mkdir -p data
[ -f data/providers.json ] || cp data/providers.example.json data/providers.json
[ -f data/auth.json ] || node -e "require('./lib/auth').loadAuthConfig()"

if command -v pm2 >/dev/null 2>&1; then
  pm2 start server.js --name kingcode-web || pm2 restart kingcode-web
  pm2 save || true
fi

echo "KingCode installed at $INSTALL_DIR"
echo "Default login: kingcode / kingcode"
