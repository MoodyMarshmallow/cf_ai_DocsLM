import { ChatRequest, Env } from "../../../../packages/shared/src/types"

export async function handleChat(request: Request, env: Env): Promise<Response> {
  return handleChatInternal(request, env, false)
}

export async function handleChatStream(request: Request, env: Env): Promise<Response> {
  return handleChatInternal(request, env, true)
}

async function handleChatInternal(request: Request, env: Env, stream: boolean): Promise<Response> {
  const body = await request.json()
  const parsed = parseChatRequest(body)
  if (!parsed.ok) {
    return jsonError(parsed.error, 400)
  }

  const status = await getProjectStatus(env, parsed.value.project_id)
  if (!status.ok) {
    return jsonError(status.error, status.status)
  }
  if (status.value !== "ready") {
    return jsonError("Project indexing not complete", 409)
  }

  const sessionId = parsed.value.session_id || crypto.randomUUID()
  const sessionCheck = await ensureSessionOwnership(env, parsed.value.project_id, sessionId)
  if (!sessionCheck.ok) {
    return jsonError(sessionCheck.error, sessionCheck.status)
  }

  console.log("[chat] request accepted", {
    project_id: parsed.value.project_id,
    session_id: sessionId,
    stream: stream,
  })

  const doId = env.CHAT_SESSIONS.idFromName(sessionId)
  const stub = env.CHAT_SESSIONS.get(doId)

  const doRequest = new Request(stream ? "https://do/chat/stream" : "https://do/chat", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      project_id: parsed.value.project_id,
      message: parsed.value.message,
    }),
    headers: {
      "content-type": "application/json",
    },
  })

  const response = await stub.fetch(doRequest)
  if (stream) {
    if (!response.ok) {
      const bodyText = await response.text()
      console.error("[chat] stream failed", {
        project_id: parsed.value.project_id,
        session_id: sessionId,
        status: response.status,
        body: bodyText,
      })
      return new Response(bodyText, {
        status: response.status,
        headers: {
          "content-type": "application/json",
          "x-session-id": sessionId,
        },
      })
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-session-id": sessionId,
      },
    })
  }

  const responseBody = await response.text()
  return new Response(responseBody, {
    status: response.status,
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId,
    },
  })
}

async function ensureSessionOwnership(
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const existing = await env.DB.prepare("SELECT project_id FROM chat_sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ project_id?: string }>()

  if (existing && existing.project_id && existing.project_id !== projectId) {
    console.warn("[chat] session ownership conflict", {
      session_id: sessionId,
      provided_project_id: projectId,
      session_project_id: existing.project_id,
    })
    return { ok: false, error: "session_id belongs to another project", status: 409 }
  }

  if (!existing) {
    const now = new Date().toISOString()
    await env.DB.prepare(
      "INSERT INTO chat_sessions (session_id, project_id, title, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(sessionId, projectId, "New chat", now, now, null)
      .run()
    console.log("[chat] session auto-created", { project_id: projectId, session_id: sessionId })
  }

  return { ok: true }
}

function parseChatRequest(body: unknown): { ok: true; value: ChatRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid JSON body" }
  }

  const payload = body as Record<string, unknown>

  if (!payload.project_id || !payload.message) {
    return { ok: false, error: "project_id and message are required" }
  }

  return {
    ok: true,
    value: {
      session_id: payload.session_id ? String(payload.session_id) : undefined,
      project_id: String(payload.project_id),
      message: String(payload.message),
    },
  }
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: {
      "content-type": "application/json",
    },
  })
}

async function getProjectStatus(
  env: Env,
  projectId: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string; status: number }> {
  const statement = env.DB.prepare(
    "SELECT status FROM projects WHERE project_id = ?",
  )
  const result = await statement.bind(projectId).first<{ status?: string }>()
  if (!result || !result.status) {
    return { ok: false, error: "Project not found", status: 404 }
  }
  return { ok: true, value: result.status }
}
