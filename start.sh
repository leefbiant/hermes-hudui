#!/bin/bash
# hermes-hudui 启动脚本

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PYTHON="/root/.hermes/hermes-agent/venv/bin/python"
HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
LOG_FILE="/root/.hermes/logs/hudui.log"
PID_FILE="/root/.hermes/hudui.pid"

start() {
    if pgrep -f "uvicorn.*backend.main" > /dev/null 2>&1; then
        echo "hermes-hudui is already running (PID: $(pgrep -f 'uvicorn.*backend.main'))"
        return 1
    fi

    echo "Starting hermes-hudui on 127.0.0.1:3001 ..."
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
    sleep 2

    if curl -s http://127.0.0.1:3001/ > /dev/null 2>&1; then
        echo "OK — hermes-hudui started (PID: $(cat $PID_FILE))"
        echo "  URL: http://127.0.0.1:3001"
        echo "  Log: $LOG_FILE"
    else
        echo "FAILED — check $LOG_FILE"
        rm -f "$PID_FILE"
        return 1
    fi
}

stop() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill "$PID" 2>/dev/null; then
            echo "Stopped (PID: $PID)"
        else
            echo "Process $PID already gone"
        fi
        rm -f "$PID_FILE"
    fi
    # Also kill by pattern
    pkill -f "uvicorn.*backend.main" 2>/dev/null
    echo "hermes-hudui stopped"
}

status() {
    if curl -s http://127.0.0.1:3001/ > /dev/null 2>&1; then
        echo "RUNNING — http://127.0.0.1:3001"
        [ -f "$PID_FILE" ] && echo "  PID file: $(cat $PID_FILE)"
        pgrep -f "uvicorn.*backend.main" | while read pid; do
            echo "  process: $pid"
        done
    else
        echo "STOPPED"
        [ -f "$PID_FILE" ] && echo "  stale PID file: $(cat $PID_FILE)"
    fi
}

restart() {
    stop
    sleep 1
    start
}

case "${1:-start}" in
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    status)  status ;;
    *)       echo "Usage: $0 {start|stop|restart|status}" ;;
esac
