import { useEffect, useState } from "react"
import ReactMarkdown from "react-markdown"
import { useParams } from "react-router-dom"
import { useNavigate } from "react-router-dom"
import remarkGfm from "remark-gfm"
import {
  createSession,
  deleteSession,
  getProjectStatus,
  listSessionMessages,
  listSessions,
  renameSession,
  sendChatStream,
} from "../lib/api"
import { clearActiveSessionId, getActiveSessionId, setActiveSessionId } from "../lib/session"
import type { ChatMessage, ChatSession } from "../lib/api"

function ProjectChatPage() {
  const params = useParams()
  const navigate = useNavigate()
  const projectId = params.projectId || ""
  const [status, setStatus] = useState<string>("indexing")
  const [statusError, setStatusError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null)
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [sessionNameDraft, setSessionNameDraft] = useState("")

  useEffect(function () {
    if (!projectId) {
      return
    }

    let cancelled = false
    async function pollStatus(): Promise<void> {
      try {
        const data = await getProjectStatus(projectId)
        if (!cancelled) {
          setStatus(data.status)
          setStatusError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setStatusError("Failed to load status")
        }
      }
    }

    void pollStatus()

    if (status !== "indexing") {
      return function () {
        cancelled = true
      }
    }

    const interval = window.setInterval(function () {
      void pollStatus()
    }, 3000)

    return function () {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [projectId, status])

  useEffect(
    function () {
      if (!projectId) {
        return
      }

      let cancelled = false
      async function loadSessionList(): Promise<void> {
        setSessionsLoading(true)
        try {
          const data = await listSessions(projectId)
          if (cancelled) {
            return
          }
          setSessions(data)
          setSessionsError(null)

          if (data.length === 0) {
            const created = await createSession(projectId, "New chat")
            if (cancelled) {
              return
            }
            setSessions([created])
            setActiveSessionId(projectId, created.session_id)
            setActiveSessionIdState(created.session_id)
            return
          }

          const saved = getActiveSessionId(projectId)
          const stillExists = saved
            ? data.find(function (session) {
                return session.session_id === saved
              })
            : null

          const nextSessionId = stillExists ? stillExists.session_id : data[0].session_id
          setActiveSessionId(projectId, nextSessionId)
          setActiveSessionIdState(nextSessionId)
        } catch (error) {
          if (!cancelled) {
            setSessionsError("Failed to load sessions")
          }
        } finally {
          if (!cancelled) {
            setSessionsLoading(false)
          }
        }
      }

      void loadSessionList()
      return function () {
        cancelled = true
      }
    },
    [projectId],
  )

  useEffect(
    function () {
      if (!projectId || !activeSessionId) {
        setMessages([])
        return
      }
      const currentSessionId = activeSessionId

      let cancelled = false
      async function loadMessages(): Promise<void> {
        setMessagesLoading(true)
        try {
          const data = await listSessionMessages(projectId, currentSessionId)
          if (cancelled) {
            return
          }
          const mapped = data.map(function (message) {
            return {
              role: message.role,
              content: message.content,
            } as ChatMessage
          })
          setMessages(mapped)
        } catch (error) {
          if (!cancelled) {
            setMessages([])
          }
        } finally {
          if (!cancelled) {
            setMessagesLoading(false)
          }
        }
      }

      void loadMessages()
      return function () {
        cancelled = true
      }
    },
    [projectId, activeSessionId],
  )

  async function handleSend(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!input.trim() || !projectId || !activeSessionId) {
      return
    }

    const text = input.trim()
    setInput("")
    setSending(true)
    setMessages(function (prev) {
      return [...prev, { role: "user", content: text }, { role: "assistant", content: "" }]
    })

    try {
      const response = await sendChatStream(
        projectId,
        activeSessionId,
        text,
        function (token: string): void {
          setMessages(function (prev) {
            if (prev.length === 0) {
              return prev
            }
            const last = prev[prev.length - 1]
            if (last.role !== "assistant") {
              return prev
            }
            const updated = prev.slice()
            updated[updated.length - 1] = {
              ...last,
              content: (last.content || "") + token,
            }
            return updated
          })
        },
      )

      setMessages(function (prev) {
        if (prev.length === 0) {
          return prev
        }
        const last = prev[prev.length - 1]
        if (last.role !== "assistant") {
          return prev
        }
        const updated = prev.slice()
        updated[updated.length - 1] = {
          ...last,
          citations: response.citations,
        }
        return updated
      })
    } catch (err) {
      setMessages(function (prev) {
        if (prev.length === 0) {
          return prev
        }
        const last = prev[prev.length - 1]
        if (last.role !== "assistant") {
          return prev
        }
        const updated = prev.slice()
        updated[updated.length - 1] = {
          ...last,
          content: "Chat failed. Please try again.",
        }
        return updated
      })
    } finally {
      setSending(false)
    }
  }

  async function handleCreateSession(): Promise<void> {
    if (!projectId) {
      return
    }
    try {
      const title = sessionNameDraft.trim() || "New chat"
      const created = await createSession(projectId, title)
      const next = [created, ...sessions]
      setSessions(next)
      setSessionNameDraft("")
      setActiveSessionId(projectId, created.session_id)
      setActiveSessionIdState(created.session_id)
      setOpenSessionMenuId(null)
      setSessionsError(null)
    } catch (error) {
      setSessionsError("Failed to create session")
    }
  }

  async function handleRenameSession(sessionId: string): Promise<void> {
    if (!projectId) {
      return
    }
    const nextTitle = window.prompt("Rename chat session")
    if (!nextTitle || !nextTitle.trim()) {
      return
    }
    try {
      await renameSession(projectId, sessionId, nextTitle.trim())
      setSessions(
        sessions.map(function (session) {
          if (session.session_id === sessionId) {
            return { ...session, title: nextTitle.trim() }
          }
          return session
        }),
      )
      setOpenSessionMenuId(null)
    } catch (error) {
      setSessionsError("Failed to rename session")
    }
  }

  async function handleDeleteSession(sessionId: string): Promise<void> {
    if (!projectId) {
      return
    }
    const confirmed = window.confirm("Delete this chat session?")
    if (!confirmed) {
      return
    }
    try {
      await deleteSession(projectId, sessionId)
      const nextSessions = sessions.filter(function (session) {
        return session.session_id !== sessionId
      })
      setSessions(nextSessions)

      if (activeSessionId === sessionId) {
        if (nextSessions.length > 0) {
          const nextId = nextSessions[0].session_id
          setActiveSessionId(projectId, nextId)
          setActiveSessionIdState(nextId)
        } else {
          clearActiveSessionId(projectId)
          setActiveSessionIdState(null)
          setMessages([])
        }
      }
      setOpenSessionMenuId(null)
      setSessionsError(null)
    } catch (error) {
      setSessionsError("Failed to delete session")
    }
  }

  const disabled = status !== "ready" || sending
  const activeSession = sessions.find(function (session) {
    return session.session_id === activeSessionId
  })

  return (
    <div className="page chat-page">
      <span className={`status status-${status} chat-page-status`}>{status}</span>

      {statusError ? <p className="error">{statusError}</p> : null}

      <section className="chat-layout">
        <aside className="sessions-panel">
          <button
            type="button"
            className="return-projects-button"
            onClick={function () {
              navigate("/")
            }}
          >
            &lt; return to projects
          </button>
          <div className="session-create-row">
            <input
              value={sessionNameDraft}
              onChange={function (event) {
                setSessionNameDraft(event.target.value)
              }}
              placeholder="New chat name"
            />
            <button className="secondary" onClick={function () {
              void handleCreateSession()
            }}>
              +
            </button>
          </div>
          {sessionsLoading ? <p className="muted">Loading sessions...</p> : null}
          {sessionsError ? <p className="error">{sessionsError}</p> : null}
          <ul className="session-list">
            {sessions.map(function (session) {
              const active = activeSessionId === session.session_id
              return (
                <li
                  key={session.session_id}
                  className={active ? "session-item active" : "session-item"}
                  onClick={function () {
                    setActiveSessionId(projectId, session.session_id)
                    setActiveSessionIdState(session.session_id)
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={function (event) {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      setActiveSessionId(projectId, session.session_id)
                      setActiveSessionIdState(session.session_id)
                    }
                  }}
                >
                  <div className="session-item-top">
                    <span className="session-main">{session.title}</span>
                    <div className="session-menu-wrap">
                      <button className="menu-trigger" onClick={function (event) {
                        event.stopPropagation()
                        if (openSessionMenuId === session.session_id) {
                          setOpenSessionMenuId(null)
                        } else {
                          setOpenSessionMenuId(session.session_id)
                        }
                      }}>
                        ⋮
                      </button>
                      {openSessionMenuId === session.session_id ? (
                        <div className="project-menu">
                          <button className="secondary" onClick={function (event) {
                            event.stopPropagation()
                            void handleRenameSession(session.session_id)
                          }}>
                            Rename
                          </button>
                          <button className="danger" onClick={function (event) {
                            event.stopPropagation()
                            void handleDeleteSession(session.session_id)
                          }}>
                            Delete
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </aside>

        <div className="chat-panel">
          <div className="chat-panel-head">
            <h3>{activeSession ? activeSession.title : "No active session"}</h3>
          </div>
          <div className="messages">
          {messagesLoading ? <p className="muted">Loading messages...</p> : null}
          {!messagesLoading && messages.length === 0 ? <p className="muted">Start a new conversation.</p> : null}
          {messages.map(function (message, index) {
            return (
              <div key={index} className={`message ${message.role}`}>
                <div className="bubble">
                  {message.role === "assistant" ? (
                    <div className="markdown-body">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          a: function MarkdownLink(props) {
                            return <a {...props} target="_blank" rel="noreferrer" />
                          },
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p>{message.content}</p>
                  )}
                  {message.citations && message.citations.length > 0 ? (
                    <ul className="citations">
                      {message.citations.map(function (citation, idx) {
                        return (
                          <li key={idx}>
                            <a href={citation.url} target="_blank" rel="noreferrer">
                              {citation.heading_path || citation.url}
                            </a>
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>

          <form className="chat-input" onSubmit={handleSend}>
            <input
              value={input}
              onChange={function (event) {
                setInput(event.target.value)
              }}
              placeholder={status === "ready" ? "Ask a question" : "Indexing in progress"}
              disabled={disabled || !activeSessionId}
            />
            <button type="submit" disabled={disabled || !activeSessionId}>
              →
            </button>
          </form>
        </div>
      </section>
    </div>
  )
}

export default ProjectChatPage
