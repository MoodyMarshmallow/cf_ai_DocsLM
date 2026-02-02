import { Env, IndexRequest } from "../../../../packages/shared/src/types"

export async function handleIndexStart(request: Request, env: Env): Promise<Response> {
  const body = await request.json()
  const parsed = parseIndexRequest(body)
  if (!parsed.ok) {
    return jsonError(parsed.error, 400)
  }

  const workflowId = await triggerWorkflow(env, parsed.value)
  return jsonResponse({ workflow_id: workflowId })
}

export async function handleIndexStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const projectId = url.searchParams.get("project_id")

  if (!projectId) {
    return jsonError("project_id is required", 400)
  }

  const statement = env.DB.prepare(
    "SELECT status, updated_at FROM projects WHERE project_id = ?",
  )
  const result = await statement.bind(projectId).first()

  if (!result) {
    return jsonError("Project not found", 404)
  }

  return jsonResponse({ status: result.status, updated_at: result.updated_at })
}

function parseIndexRequest(body: unknown): { ok: true; value: IndexRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid JSON body" }
  }

  const payload = body as Record<string, unknown>

  if (!payload.project_id || !payload.source_ref) {
    return { ok: false, error: "project_id and source_ref are required" }
  }

  return {
    ok: true,
    value: {
      project_id: String(payload.project_id),
      source_type: "github",
      source_ref: String(payload.source_ref),
    },
  }
}

async function triggerWorkflow(env: Env, input: IndexRequest): Promise<string> {
  if (!env.WORKFLOWS || !env.WORKFLOWS.create) {
    return "workflow_disabled"
  }

  const result = await env.WORKFLOWS.create({
    params: input,
  })

  if (result && result.id) {
    return result.id
  }

  return "workflow_started"
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
