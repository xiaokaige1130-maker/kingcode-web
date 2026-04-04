$ErrorActionPreference = "Stop"

$ProjectDir = if ($env:PROJECT_DIR) { $env:PROJECT_DIR } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
Set-Location $ProjectDir

git pull origin main
npm install
node --check server.js

if (Get-Command pm2 -ErrorAction SilentlyContinue) {
  try {
    pm2 restart kingcode-web | Out-Null
  } catch {
  }
}

Write-Host "KingCode updated."
