#!/bin/bash
exec /root/.hermes/hermes-agent/venv/bin/python -c "
import sys
sys.path.insert(0, '/data/hermes-hudui')
import uvicorn, os
os.environ['HERMES_HOME'] = '/root/.hermes'
uvicorn.run('backend.main:app', host='0.0.0.0', port=3001)
"
