#!/bin/sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PID_FILE="$APP_DIR/app.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No pid file."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped: $PID"
else
  echo "Process not running: $PID"
fi

rm -f "$PID_FILE"
