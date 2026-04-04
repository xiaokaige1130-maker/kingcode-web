#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/xiaokaige1130-maker/kingcode-web.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/kingcode-web}"

require_min_node() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -lt 18 ]; then
    echo "Node.js 版本过低：当前 $(node -v)，至少需要 v18。"
    echo "建议先安装 Node.js 20 后再运行本脚本。"
    exit 1
  fi
}

command -v git >/dev/null 2>&1 || { echo "Missing dependency: git"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Missing dependency: node"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Missing dependency: npm"; exit 1; }
require_min_node

if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm install

mkdir -p data
[ -f data/providers.json ] || cp data/providers.example.json data/providers.json
[ -f data/auth.json ] || node -e "require('./lib/auth').loadAuthConfig()"
node -e "const fs=require('fs'); const path=require('path'); const file=path.join(process.cwd(),'data','providers.json'); const data=JSON.parse(fs.readFileSync(file,'utf8')); data.workspaceRoot=process.cwd(); if (typeof data.allowPublicAccess !== 'boolean') data.allowPublicAccess=true; if (!data.listenHost) data.listenHost=data.allowPublicAccess ? '0.0.0.0' : '127.0.0.1'; if (!data.listenPort) data.listenPort=4780; fs.writeFileSync(file, JSON.stringify(data, null, 2));"

if command -v pm2 >/dev/null 2>&1; then
  pm2 start server.js --name kingcode-web || pm2 restart kingcode-web
  pm2 save || true
fi

echo "KingCode installed at $INSTALL_DIR"
echo "Default login: kingcode / kingcode"
echo "Workspace root: $INSTALL_DIR"
