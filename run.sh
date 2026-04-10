#!/bin/bash
exec /root/.hermes/hermes-agent/venv/bin/python -c "
import sys
sys.path.insert(0, '/data/hermes-hudui')
import uvicorn, os
os.environ['HERMES_HOME'] = '/root/.hermes'
uvicorn.run('backend.main:app', host='127.0.0.1', port=3001)
"
