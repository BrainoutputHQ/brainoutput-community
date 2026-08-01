# BrainOutput Community Edition — Windows install (PowerShell)
# One-liner:  irm https://raw.githubusercontent.com/BrainoutputHQ/brainoutput-community/main/install.ps1 | iex
# Zero npm dependencies. Requires only Node ≥18. Never needs a BrainOutput account or paid models.
$ErrorActionPreference = "Stop"

Write-Host "BrainOutput Community Edition — install"
Write-Host "======================================"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "✗ Node.js is required (≥18). Install with:  winget install OpenJS.NodeJS" -ForegroundColor Red
  exit 1
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Write-Host "✗ Node ≥18 required (found $(node -v))." -ForegroundColor Red; exit 1 }
Write-Host "✓ Node $(node -v)"

$dir = Join-Path $env:USERPROFILE "brainoutput-community"
if (Test-Path (Join-Path $dir ".git")) {
  Write-Host "✓ existing checkout at $dir — updating"
  git -C $dir pull --ff-only
} else {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "✗ git is required. Install with:  winget install Git.Git" -ForegroundColor Red
    exit 1
  }
  git clone https://github.com/BrainoutputHQ/brainoutput-community.git $dir
}
Set-Location $dir

node bo-community.mjs doctor
node bo-community.mjs setup

Write-Host ""
Write-Host "Next:"
Write-Host "  node bo-community.mjs serve      → the app at http://127.0.0.1:4177"
Write-Host "  node bo-community.mjs connect    → bridge this PC to a hosted workspace (local models + granted folders)"
