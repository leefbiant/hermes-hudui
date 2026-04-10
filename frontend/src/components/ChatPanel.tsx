import { useState, useRef, useEffect, useCallback } from 'react'
import Panel from './Panel'

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  streaming?: boolean
}

interface ChatPanelProps {
  className?: string
}

export default function ChatPanel({ className = '' }: ChatPanelProps) {
  // Persist to localStorage so tab-switch doesn't lose state
  const [messages, setMessages] = useState<Message[]>(() => {
    try { return JSON.parse(localStorage.getItem('hudui_messages') || '[]') } catch { return [] }
  })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string>(() => localStorage.getItem('hudui_session_id') || '')
  const [sessions, setSessions] = useState<any[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Persist messages and sessionId to localStorage on change
  useEffect(() => {
    localStorage.setItem('hudui_messages', JSON.stringify(messages))
  }, [messages])

  useEffect(() => {
    if (sessionId) localStorage.setItem('hudui_session_id', sessionId)
    else localStorage.removeItem('hudui_session_id')
  }, [sessionId])

  // Load recent sessions on mount; also restore messages from persisted sessionId
  useEffect(() => {
    fetch('/api/chat/sessions')
      .then(r => r.json())
      .then(d => setSessions(d.sessions || []))
      .catch(() => {})

    // Restore messages from persisted sessionId if any
    const savedSid = localStorage.getItem('hudui_session_id')
    const savedMsgs = localStorage.getItem('hudui_messages')
    if (savedSid && savedMsgs) {
      try {
        const msgs = JSON.parse(savedMsgs)
        if (Array.isArray(msgs) && msgs.length > 0) {
          // Restore both sessionId and messages — no need to re-fetch,
          // they were persisted at every change
          return
        }
      } catch { /* fall through to fetch */ }
    }
    // If no local messages, try to load history for saved session
    if (savedSid) {
      fetch(`/api/chat/history?session_id=${encodeURIComponent(savedSid)}`)
        .then(r => r.json())
        .then(d => {
          if (d.messages && d.messages.length > 0) {
            setMessages(d.messages.map((m: any) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            })))
          }
        })
        .catch(() => {})
    }
  }, [])

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-resize textarea
  const resizeTextarea = () => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 150) + 'px'
    }
  }

  const loadSession = useCallback(async (sid: string) => {
    setSessionId(sid)
    setShowHistory(false)
    const res = await fetch(`/api/chat/history?session_id=${encodeURIComponent(sid)}`)
    const data = await res.json()
    const msgs: Message[] = (data.messages || []).map((m: any) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }))
    setMessages(msgs)
  }, [])

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return

    const userMsg: Message = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    // Build messages payload
    const allMessages = [...messages, userMsg].map(m => ({
      role: m.role,
      content: m.content,
    }))

    abortRef.current = new AbortController()

    try {
      const res = await fetch('/api/chat/chat?stream=true', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hermes-Session-Source': 'webchat',
        },
        body: JSON.stringify({
          messages: allMessages,
          stream: true,
          session_id: sessionId || undefined,
        }),
        signal: abortRef.current.signal,
      })

      if (!res.ok) {
        const err = await res.text()
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err}` }])
        setLoading(false)
        return
      }

      // Extract session_id from headers if new session
      const newSid = res.headers.get('X-Hermes-Session-Id')
      if (newSid && !sessionId) {
        setSessionId(newSid)
      }

      // Read SSE stream
      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')

      const assistantMsg: Message = { role: 'assistant', content: '', streaming: true }
      setMessages(prev => [...prev, assistantMsg])

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') continue

            // SSE format: data: {"choices":[{"delta":{"content":"..."}}]}
            try {
              const parsed = JSON.parse(data)
              const content = parsed.choices?.[0]?.delta?.content
              if (content) {
                setMessages(prev => {
                  const updated = [...prev]
                  const last = updated[updated.length - 1]
                  if (last?.streaming) {
                    last.content += content
                  }
                  return [...updated]
                })
              }
            } catch {
              // Try raw content format
              if (data.startsWith('{')) {
                try {
                  const parsed = JSON.parse(data)
                  const content = parsed.content || parsed.text || parsed.message?.content
                  if (content && typeof content === 'string') {
                    setMessages(prev => {
                      const updated = [...prev]
                      const last = updated[updated.length - 1]
                      if (last?.streaming) {
                        last.content += content
                      }
                      return [...updated]
                    })
                  }
                } catch { /* skip non-JSON */ }
              } else if (data) {
                // Raw text chunk
                setMessages(prev => {
                  const updated = [...prev]
                  const last = updated[updated.length - 1]
                  if (last?.streaming) {
                    last.content += data
                  }
                  return [...updated]
                })
              }
            }
          }
        }
      }

      // Finalize message
      setMessages(prev => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last?.streaming) {
          last.streaming = false
        }
        return [...updated]
      })
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setMessages(prev => {
          const updated = [...prev]
          const last = updated[updated.length - 1]
          if (last?.streaming) {
            last.content += '\n[stopped]'
            last.streaming = false
          }
          return [...updated]
        })
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
      }
    } finally {
      setLoading(false)
    }
  }, [messages, sessionId, loading])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  const stopGeneration = () => {
    abortRef.current?.abort()
  }

  const clearChat = () => {
    setMessages([])
    setSessionId('')
  }

  return (
    <div className={`grid gap-2 p-2 ${className}`}>
      {/* Chat area */}
      <Panel title="WebChat" className="col-span-full" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)', maxHeight: '700px' }}>
        {/* Toolbar */}
        <div className="flex items-center gap-2 mb-2 pb-2" style={{ borderBottom: '1px solid var(--hud-border)' }}>
          <span className="text-[12px]" style={{ color: 'var(--hud-text-dim)' }}>
            {sessionId ? `session: ${sessionId.slice(0, 8)}…` : 'new session'}
          </span>
          <button
            onClick={() => setShowHistory(h => !h)}
            className="text-[12px] px-2 py-0.5 cursor-pointer"
            style={{ color: 'var(--hud-text-dim)', background: 'var(--hud-bg-hover)', border: '1px solid var(--hud-border)', borderRadius: '4px' }}
          >
            {showHistory ? 'hide history' : 'history'}
          </button>
          <button
            onClick={clearChat}
            className="text-[12px] px-2 py-0.5 cursor-pointer"
            style={{ color: 'var(--hud-text-dim)', background: 'var(--hud-bg-hover)', border: '1px solid var(--hud-border)', borderRadius: '4px' }}
          >
            clear
          </button>
          {loading && (
            <button
              onClick={stopGeneration}
              className="text-[12px] px-2 py-0.5 cursor-pointer"
              style={{ color: 'var(--hud-error)', background: 'var(--hud-bg-hover)', border: '1px solid var(--hud-border)', borderRadius: '4px' }}
            >
              stop
            </button>
          )}
        </div>

        {/* Session history dropdown */}
        {showHistory && (
          <div className="mb-2 p-2" style={{ background: 'var(--hud-bg-hover)', borderRadius: '4px', maxHeight: '120px', overflowY: 'auto' }}>
            {sessions.length === 0 ? (
              <div className="text-[12px]" style={{ color: 'var(--hud-text-dim)' }}>No sessions yet</div>
            ) : (
              sessions.map(s => (
                <div
                  key={s.id}
                  onClick={() => loadSession(s.id)}
                  className="py-1 px-1 text-[12px] cursor-pointer"
                  style={{ borderBottom: '1px solid var(--hud-border)' }}
                >
                  <span style={{ color: 'var(--hud-primary)' }}>{s.title || s.id.slice(0, 8)}</span>
                  <span style={{ color: 'var(--hud-text-dim)' }}> · {s.message_count} msgs · {s.model}</span>
                </div>
              ))
            )}
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto mb-2" style={{ minHeight: '0' }}>
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full" style={{ color: 'var(--hud-text-dim)' }}>
              <div className="text-center">
                <div className="text-2xl mb-2">☤</div>
                <div className="text-[13px]">Send a message to start chatting</div>
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className="mb-3">
              <div className="text-[11px] uppercase tracking-wider mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                {msg.role === 'user' ? 'you' : 'hermes'}
              </div>
              <div
                className="px-3 py-2 text-[13px] whitespace-pre-wrap break-words"
                style={{
                  background: msg.role === 'user' ? 'var(--hud-bg-hover)' : 'transparent',
                  borderLeft: msg.role === 'user' ? 'none' : '2px solid var(--hud-primary)',
                  borderRadius: msg.role === 'user' ? '6px' : '0 6px 6px 0',
                  color: msg.role === 'user' ? 'var(--hud-text)' : 'var(--hud-primary)',
                  opacity: msg.streaming ? 0.8 : 1,
                }}
              >
                {msg.content}
                {msg.streaming && <span className="animate-pulse"> ▊</span>}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => { setInput(e.target.value); resizeTextarea() }}
            onKeyDown={handleKeyDown}
            placeholder="Send a message... (Enter to send, Shift+Enter for newline)"
            rows={1}
            disabled={loading}
            className="flex-1 px-3 py-2 text-[13px] resize-none"
            style={{
              background: 'var(--hud-bg-hover)',
              border: '1px solid var(--hud-border)',
              borderRadius: '6px',
              color: 'var(--hud-text)',
              outline: 'none',
              fontFamily: 'inherit',
              lineHeight: '1.5',
              minHeight: '40px',
              maxHeight: '150px',
            }}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={loading || !input.trim()}
            className="px-4 py-2 text-[13px] font-medium cursor-pointer disabled:opacity-40"
            style={{
              background: 'var(--hud-primary)',
              color: 'var(--hud-bg-deep)',
              borderRadius: '6px',
              border: 'none',
            }}
          >
            {loading ? '…' : 'Send'}
          </button>
        </div>
      </Panel>
    </div>
  )
}
