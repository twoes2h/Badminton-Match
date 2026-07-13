#!/bin/sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
LOG_FILE="$APP_DIR/watchdog.log"
PORT="${PORT:-3000}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:$PORT/api/healthz?strict=1}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node ]; then
  NODE_BIN="/usr/local/bin/node"
fi

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

health_ok() {
  BODY="$(curl -fsS --max-time 6 "$HEALTH_URL" 2>/dev/null || true)"
  printf '%s' "$BODY" | grep -q '"ok":true'
}

cd "$APP_DIR"

if health_ok; then
  exit 0
fi

log "health check failed; restarting service"
./scripts/stop-nas.sh >> "$LOG_FILE" 2>&1 || true
sleep 1
./scripts/start-nas.sh >> "$LOG_FILE" 2>&1 || true
sleep 10

if health_ok; then
  log "service recovered after restart"
  exit 0
fi

log "health still failed; running stuck-state repair"
if [ -n "$NODE_BIN" ]; then
  "$NODE_BIN" scripts/repair-stuck-state.js >> "$LOG_FILE" 2>&1 || log "repair script failed"
else
  log "node not found; skipped repair"
fi

./scripts/stop-nas.sh >> "$LOG_FILE" 2>&1 || true
sleep 1
./scripts/start-nas.sh >> "$LOG_FILE" 2>&1 || true
sleep 10

if health_ok; then
  log "service recovered after repair"
  exit 0
fi

log "service still unhealthy after restart and repair"
exit 1
