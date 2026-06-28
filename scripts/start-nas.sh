#!/bin/sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PID_FILE="$APP_DIR/app.pid"
LOG_FILE="$APP_DIR/app.log"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node ]; then
  NODE_BIN="/usr/local/bin/node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "node not found. Set NODE_BIN or add node to PATH." >&2
  exit 1
fi

cd "$APP_DIR"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Already running: $PID"
    exit 0
  fi
fi

nohup "$NODE_BIN" src/server.js >> "$LOG_FILE" 2>&1 < /dev/null &
echo "$!" > "$PID_FILE"
echo "Started: $(cat "$PID_FILE")"
