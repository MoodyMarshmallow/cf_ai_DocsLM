import { ChatRequest, Env } from "../../../../packages/shared/src/types"

export async function handleChat(request: Request, env: Env): Promise<Response> {
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
  const doId = env.CHAT_SESSIONS.idFromName(sessionId)
  const stub = env.CHAT_SESSIONS.get(doId)

  const doRequest = new Request("https://do/chat", {
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
  const responseBody = await response.text()
  return new Response(responseBody, {
    status: response.status,
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId,
    },
  })
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
