#!/bin/bash
cd "$(dirname "$0")" || exit 1
# Use the Node.js that comes with this download if it's there, otherwise one installed on this Mac.
if [ -x ./node/bin/node ]; then
  # Downloaded files are flagged by macOS; this clears the flag on our own copy of Node so it can start.
  xattr -dr com.apple.quarantine ./node 2>/dev/null
  NODE=./node/bin/node
else
  for p in /usr/local/bin /opt/homebrew/bin; do [ -x "$p/node" ] && export PATH="$p:$PATH"; done
  NODE=$(command -v node)
fi
if [ -z "$NODE" ]; then
  echo
  echo "  Node.js was not found. Download the Spotlight version for Mac that includes it,"
  echo "  or install the free LTS version from https://nodejs.org and double-click this file again."
  echo
  open https://nodejs.org
  read -r -p "  Press Enter to close. "
  exit 1
fi
echo
echo "  If macOS asks whether node may accept incoming network connections, click Allow."
"$NODE" local/server.mjs
