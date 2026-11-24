#!/bin/sh
cd "$(dirname "$0")" || exit 1
# Use the Node.js that comes with this download if it's there, otherwise the system one.
if [ -x ./node/bin/node ]; then NODE=./node/bin/node; else NODE=$(command -v node); fi
[ -n "$NODE" ] || { echo "Node.js 22.13+ is required: download the Spotlight version that includes it, or see https://nodejs.org"; exit 1; }
exec "$NODE" local/server.mjs "$@"
