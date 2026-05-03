#!/usr/bin/env bash
# verify-cline.sh — quick check used in CI / install.sh
set -e
if ! command -v cline >/dev/null 2>&1; then
  echo "cline not on PATH" 1>&2
  exit 1
fi
cline --version
GS="$HOME/.cline/data/globalState.json"
if [ ! -f "$GS" ]; then
  echo "$GS not found — cline has not been initialized" 1>&2
  exit 2
fi
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$GS"
echo "cline OK"
