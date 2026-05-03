#!/usr/bin/env bash
# verify-opencode.sh — quick check used in CI / install.sh
set -e
if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode not on PATH" 1>&2
  exit 1
fi
opencode --version
echo "opencode OK"
