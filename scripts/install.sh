#!/usr/bin/env bash
# Tote bootstrap: checks prerequisites, installs deps, launches the app.
set -e
cd "$(dirname "$0")/.."

echo "== Tote setup =="

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 20+ from https://nodejs.org and re-run."
  exit 1
fi
echo "node $(node -v)  ✓"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found - it ships with Node.js. Reinstall Node and re-run."
  exit 1
fi
echo "npm $(npm -v)  ✓"

# node-pty needs a C++ toolchain on first install
if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
  echo "warning: make/g++ not found. node-pty may need build tools:"
  echo "  Debian/Ubuntu: sudo apt install build-essential python3"
  echo "  Fedora:        sudo dnf install gcc-c++ make python3"
  echo "  macOS:         xcode-select --install"
fi

echo "installing dependencies..."
npm install --no-audit --no-fund

echo
echo "Done. Starting Tote (first run opens the setup wizard)..."
npm start
