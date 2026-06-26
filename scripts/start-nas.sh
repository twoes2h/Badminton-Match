#!/bin/sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PID_FILE="$APP_DIR/app.pid"
LOG_FILE="$APP_DIR/app.log"

cd "$APP_DIR"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Already running: $PID"
    exit 0
  fi
fi

nohup node src/server.js >> "$LOG_FILE" 2>&1 &
echo "$!" > "$PID_FILE"
echo "Started: $(cat "$PID_FILE")"
