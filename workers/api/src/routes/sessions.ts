import { Env } from "../../../../packages/shared/src/types"

export async function handleSessionList(request: Request, env: Env): Promise<Response> {
  const projectId = extractProjectId(request.url)
  if (!projectId) {
    return jsonError("project_id is required", 400)
  }

  const exists = await projectExists(env, projectId)
  if (!exists) {
    return jsonError("Project not found", 404)
  }
  
  const statement = env.DB.prepare(
    "SELECT session_id, project_id, title, created_at, updated_at, last_message_at FROM chat_sessions WHERE project_id = ? ORDER BY updated_at DESC",
  )
  const result = await statement.bind(projectId).all<{ results?: SessionRow[] }>()
  return jsonResponse({ sessions: result.results || [] })
}

export async function handleSessionCreate(request: Request, env: Env): Promise<Response> {
  const projectId = extractProjectId(request.url)
  if (!projectId) {
    return jsonError("project_id is required", 400)
  }

  const exists = await projectExists(env, projectId)
  if (!exists) {
    return jsonError("Project not found", 404)
  }

  const body = await request.json().catch(function () {
    return null
  })
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : null

  const title = payload && payload.title ? String(payload.title).trim() : "New chat"
  const sessionId = crypto.randomUUID()
  const now = new Date().toISOString()

  await env.DB.prepare(
    "INSERT INTO chat_sessions (session_id, project_id, title, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(sessionId, projectId, title || "New chat", now, now, null)
    .run()

  console.log("[sessions] created", { project_id: projectId, session_id: sessionId })
  return jsonResponse({
    session_id: sessionId,
    project_id: projectId,
    title: title || "New chat",
    created_at: now,
    updated_at: now,
    last_message_at: null,
  })
}

export async function handleSessionUpdate(request: Request, env: Env): Promise<Response> {
  const ids = extractProjectAndSessionId(request.url)
  if (!ids.projectId || !ids.sessionId) {
    return jsonError("project_id and session_id are required", 400)
  }

  const body = await request.json().catch(function () {
    return null
  })
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400)
  }

  const payload = body as Record<string, unknown>
  const title = payload.title ? String(payload.title).trim() : ""
  if (!title) {
    return jsonError("title is required", 400)
  }

  const existing = await env.DB.prepare(
    "SELECT session_id FROM chat_sessions WHERE session_id = ? AND project_id = ?",
  )
    .bind(ids.sessionId, ids.projectId)
    .first()
  if (!existing) {
    return jsonError("Session not found", 404)
  }

  const now = new Date().toISOString()
  await env.DB.prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE session_id = ? AND project_id = ?")
    .bind(title, now, ids.sessionId, ids.projectId)
    .run()

  console.log("[sessions] updated", { project_id: ids.projectId, session_id: ids.sessionId })
  return jsonResponse({ session_id: ids.sessionId, project_id: ids.projectId, title: title, updated_at: now })
}

export async function handleSessionDelete(request: Request, env: Env): Promise<Response> {
  const ids = extractProjectAndSessionId(request.url)
  if (!ids.projectId || !ids.sessionId) {
    return jsonError("project_id and session_id are required", 400)
  }

  const existing = await env.DB.prepare(
    "SELECT session_id FROM chat_sessions WHERE session_id = ? AND project_id = ?",
  )
    .bind(ids.sessionId, ids.projectId)
    .first()
  if (!existing) {
    return jsonError("Session not found", 404)
  }

  await env.DB.prepare("DELETE FROM chat_logs WHERE session_id = ? AND project_id = ?")
    .bind(ids.sessionId, ids.projectId)
    .run()
  await env.DB.prepare("DELETE FROM chat_sessions WHERE session_id = ? AND project_id = ?")
    .bind(ids.sessionId, ids.projectId)
    .run()

  console.log("[sessions] deleted", { project_id: ids.projectId, session_id: ids.sessionId })
  return jsonResponse({ deleted: true, session_id: ids.sessionId })
}

export async function handleSessionMessages(request: Request, env: Env): Promise<Response> {
  const ids = extractProjectAndSessionId(request.url)
  if (!ids.projectId || !ids.sessionId) {
    return jsonError("project_id and session_id are required", 400)
  }

  const session = await env.DB.prepare(
    "SELECT session_id FROM chat_sessions WHERE session_id = ? AND project_id = ?",
  )
    .bind(ids.sessionId, ids.projectId)
    .first()
  if (!session) {
    return jsonError("Session not found", 404)
  }

  const result = await env.DB.prepare(
    "SELECT turn_id, session_id, project_id, role, content, created_at FROM chat_logs WHERE project_id = ? AND session_id = ? ORDER BY turn_id ASC",
  )
    .bind(ids.projectId, ids.sessionId)
    .all<{ results?: MessageRow[] }>()

  return jsonResponse({ messages: result.results || [] })
}

async function projectExists(env: Env, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT project_id FROM projects WHERE project_id = ?")
    .bind(projectId)
    .first()
  return Boolean(row)
}

function extractProjectId(requestUrl: string): string | null {
  const url = new URL(requestUrl)
  const parts = url.pathname.split("/")
  if (parts.length < 5) {
    return null
  }
  return parts[3] || null
}

function extractProjectAndSessionId(requestUrl: string): { projectId: string | null; sessionId: string | null } {
  const url = new URL(requestUrl)
  const parts = url.pathname.split("/")
  if (parts.length < 6) {
    return { projectId: null, sessionId: null }
  }
  if (parts[4] !== "sessions") {
    return { projectId: null, sessionId: null }
  }
  return { projectId: parts[3] || null, sessionId: parts[5] || null }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  })
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: {
      "content-type": "application/json",
    },
  })
}

interface SessionRow {
  session_id: string
  project_id: string
  title: string
  created_at: string
  updated_at: string
  last_message_at?: string | null
}

interface MessageRow {
  turn_id: number
  session_id: string
  project_id: string
  role: string
  content: string
  created_at: string
}
