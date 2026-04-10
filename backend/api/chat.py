"""Chat API — bridges webchat UI to Hermes API Server (OpenAI-compatible)."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter()

HERMES_API_BASE = "http://127.0.0.1:8642/v1"
_api_key: Optional[str] = None


class ChatRequest(BaseModel):
    messages: List[Dict[str, str]]
    stream: bool = False
    session_id: Optional[str] = None


def _get_api_key() -> Optional[str]:
    global _api_key
    if _api_key is None:
        _api_key = os.getenv("HERMES_API_KEY", "")
        if not _api_key:
            hermes_home = os.getenv("HERMES_HOME") or str(Path.home() / ".hermes")
            env_file = Path(hermes_home) / ".env"
            if env_file.exists():
                for line in env_file.read_text().splitlines():
                    if line.startswith("API_SERVER_KEY=") or line.startswith("HERMES_API_KEY="):
                        _api_key = line.split("=", 1)[1].strip()
                        break
    return _api_key or None


def _get_hermes_db() -> Optional[str]:
    home = os.getenv("HERMES_HOME")
    if not home:
        home = str(Path.home() / ".hermes")
    db_path = Path(home) / "state.db"
    return str(db_path) if db_path.exists() else None


@router.get("/chat/models")
async def list_models():
    """List available models from Hermes API Server."""
    import httpx
    key = _get_api_key()
    headers: Dict[str, str] = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{HERMES_API_BASE}/models", headers=headers)
        resp.raise_for_status()
        return resp.json()


@router.post("/chat/chat")
async def chat_completions(request: ChatRequest):
    """
    Send a chat message to Hermes via the API Server.

    messages: [{"role": "user"|"assistant"|"system", "content": "..."}]
    stream: if True, returns SSE stream
    session_id: optional, for conversation continuity (requires API key)
    """
    import httpx
    key = _get_api_key()

    headers: Dict[str, str] = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    # Normalize message roles
    normalized_messages = []
    for msg in request.messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "bot":
            role = "assistant"
        normalized_messages.append({"role": role, "content": content})

    payload: Dict[str, Any] = {
        "model": "hermes-agent",
        "messages": normalized_messages,
        "stream": request.stream,
    }

    if request.session_id:
        headers["X-Hermes-Session-Id"] = request.session_id

    # Tell API Server to mark this session as "webchat"
    headers["X-Hermes-Session-Source"] = "webchat"

    async with httpx.AsyncClient(timeout=60.0) as client:
        if request.stream:
            resp = await client.post(
                f"{HERMES_API_BASE}/chat/completions",
                json=payload,
                headers=headers,
                timeout=httpx.Timeout(60.0),
            )
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)
            return Response(
                content=resp.content,
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )
        else:
            resp = await client.post(
                f"{HERMES_API_BASE}/chat/completions",
                json=payload, headers=headers,
            )
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)
            return resp.json()


@router.get("/chat/history")
async def get_chat_history(session_id: str):
    """Load conversation messages for a session directly from state.db."""
    db_path = _get_hermes_db()
    if not db_path:
        return {"session_id": session_id, "messages": []}

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("""
            SELECT role, content, timestamp
            FROM messages
            WHERE session_id = ?
            ORDER BY timestamp ASC
        """, (session_id,))
        rows = cursor.fetchall()
        conn.close()

        messages = []
        for row in rows:
            role = row["role"] or "user"
            content = row["content"] or ""
            if role == "tool" or (role == "user" and content.startswith("[TOOL_CALL]")):
                continue  # skip tool call markers in chat view
            messages.append({
                "role": role,
                "content": content,
                "created_at": row["timestamp"],
            })
        return {"session_id": session_id, "messages": messages}
    except Exception as e:
        return {"session_id": session_id, "messages": [], "error": str(e)}


@router.get("/chat/sessions")
async def list_chat_sessions(limit: int = 20):
    """List recent chat sessions from state.db."""
    db_path = _get_hermes_db()
    if not db_path:
        return {"sessions": []}

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, source, title, model, started_at, message_count
            FROM sessions
            WHERE source = 'webchat'
            ORDER BY started_at DESC
            LIMIT ?
        """, (limit,))
        rows = cursor.fetchall()
        conn.close()

        sessions = []
        for row in rows:
            sessions.append({
                "id": row["id"],
                "title": row["title"] or row["id"][:8],
                "source": row["source"] or "api_server",
                "started_at": row["started_at"],
                "message_count": row["message_count"],
                "model": row["model"] or "unknown",
            })
        return {"sessions": sessions}
    except Exception as e:
        return {"sessions": [], "error": str(e)}
