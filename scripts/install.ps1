$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:REPO_URL) { $env:REPO_URL } else { "git@github.com:xiaokaige1130-maker/omnicode-web.git" }
$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $HOME "omnicode-web" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Missing dependency: git" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Missing dependency: node" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Missing dependency: npm" }

if (-not (Test-Path (Join-Path $InstallDir ".git"))) {
  git clone $RepoUrl $InstallDir
}

Set-Location $InstallDir
npm install

New-Item -ItemType Directory -Force -Path data | Out-Null
if (-not (Test-Path "data/providers.json")) { Copy-Item "data/providers.example.json" "data/providers.json" }

Write-Host "KingCode installed at $InstallDir"
Write-Host "Default login: kingcode / kingcode"
