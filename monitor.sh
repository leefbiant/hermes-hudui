#!/bin/bash
# hermes-hudui 监控脚本 — 检查服务是否存活，失败时自动重启

VENV_PYTHON="/root/.hermes/hermes-agent/venv/bin/python"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
LOG_FILE="/root/.hermes/logs/hudui.log"
PID_FILE="/root/.hermes/hudui.pid"
ALERT_LOG="/root/.hermes/logs/hudui_alert.log"

check() {
    curl -sf http://127.0.0.1:3001/ > /dev/null 2>&1
}

restart_hudui() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] hermes-hudui restart triggered" >> "$ALERT_LOG"
    # Kill old process
    pkill -f "uvicorn.*backend.main" 2>/dev/null
    [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
    sleep 2
    # Start new
    cd "$SCRIPT_DIR"
    nohup "$VENV_PYTHON" -c "
import sys
sys.path.insert(0, '$SCRIPT_DIR')
from backend.main import cli
import uvicorn, os
os.environ['HERMES_HOME'] = '$HERMES_HOME'
uvicorn.run('backend.main:app', host='127.0.0.1', port=3001)
" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 3
}

# ---- Main ----
MODE="${1:-check}"   # check | watch

if [ "$MODE" = "watch" ]; then
    echo "Watching hermes-hudui... (Ctrl+C to stop)"
    while true; do
        if check; then
            echo "$(date '+%H:%M:%S') OK"
        else
            echo "$(date '+%H:%M:%S') DOWN — restarting..."
            restart_hudui
        fi
        sleep 30
    done
else
    # One-shot check
    if check; then
        echo "hermes-hudui: OK"
        curl -s http://127.0.0.1:3001/api/health | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'  model: {d[\"config_provider\"]}/{d[\"config_model\"]}')
print(f'  API keys: {d[\"keys_ok\"]} OK, {d[\"keys_missing\"]} missing')
print(f'  services: {d[\"services_ok\"]}/{len(d[\"services\"])} running')
" 2>/dev/null
        exit 0
    else
        echo "hermes-hudui: DOWN"
        exit 1
    fi
fi
