#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  for p in /usr/local/bin /opt/homebrew/bin; do [ -x "$p/node" ] && export PATH="$p:$PATH"; done
fi
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed on this computer."
  echo "  Install the free LTS version from https://nodejs.org, then double-click this file again."
  echo
  open https://nodejs.org
  read -r -p "  Press Enter to close. "
  exit 1
fi
echo
echo "  If macOS asks whether node may accept incoming network connections, click Allow."
node local/server.mjs
