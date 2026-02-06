import { ulid } from "ulid"
import { Env, IndexRequest } from "../../../../packages/shared/src/types"

/**
 * Routes project creation requests for GitHub sources.
 */
export async function handleProjectList(_request: Request, env: Env): Promise<Response> {
  const statement = env.DB.prepare(
    "SELECT project_id, name, source_ref, status, created_at, updated_at FROM projects ORDER BY created_at DESC",
  )
  const result = await statement.all<{ results?: ProjectRow[] }>()
  return jsonResponse({ projects: result.results || [] })
}

export async function handleProjectCreate(request: Request, env: Env): Promise<Response> {
  return handleJsonProjectCreate(request, env)
}

export async function handleProjectUpdate(request: Request, env: Env): Promise<Response> {
  const projectId = extractProjectId(request.url)
  if (!projectId) {
    return jsonError("project_id is required", 400)
  }

  const existing = await env.DB.prepare(
    "SELECT project_id FROM projects WHERE project_id = ?",
  )
    .bind(projectId)
    .first()
  if (!existing) {
    return jsonError("Project not found", 404)
  }

  const body = await request.json()
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400)
  }

  const payload = body as Record<string, unknown>
  const name = payload.name ? String(payload.name).trim() : undefined
  const sourceRef = payload.source_ref ? String(payload.source_ref).trim() : undefined

  if (!name && !sourceRef) {
    return jsonError("name or source_ref is required", 400)
  }

  if (name && !isValidProjectName(name)) {
    return jsonError("name must be alphanumeric with spaces or dashes", 400)
  }

  const nameLower = name ? name.toLowerCase() : undefined
  if (nameLower) {
    const conflict = await env.DB.prepare(
      "SELECT project_id FROM projects WHERE name_lower = ? AND project_id != ?",
    )
      .bind(nameLower, projectId)
      .first()
    if (conflict) {
      return jsonError("Project name already exists", 409)
    }
  }

  const now = new Date().toISOString()
  const updates: string[] = []
  const values: Array<string | null> = []

  if (name) {
    updates.push("name = ?", "name_lower = ?")
    values.push(name, nameLower || name)
  }
  if (sourceRef) {
    updates.push("source_ref = ?", "source_type = ?", "status = ?")
    values.push(sourceRef, "github", "indexing")
  }

  updates.push("updated_at = ?")
  values.push(now)

  const sql = "UPDATE projects SET " + updates.join(", ") + " WHERE project_id = ?"
  values.push(projectId)
  await env.DB.prepare(sql).bind(...values).run()

  if (sourceRef) {
    try {
      const workflowId = await triggerWorkflow(env, {
        project_id: projectId,
        source_type: "github",
        source_ref: sourceRef,
      })
      return jsonResponse({ project_id: projectId, workflow_id: workflowId })
    } catch (error) {
      void error
      return jsonError("Failed to start workflow", 500)
    }
  }

  return jsonResponse({ project_id: projectId })
}

export async function handleProjectDelete(request: Request, env: Env): Promise<Response> {
  const projectId = extractProjectId(request.url)
  if (!projectId) {
    return jsonError("project_id is required", 400)
  }

  const existing = await env.DB.prepare(
    "SELECT project_id FROM projects WHERE project_id = ?",
  )
    .bind(projectId)
    .first()
  if (!existing) {
    return jsonError("Project not found", 404)
  }

  const chunkRows = await env.DB.prepare(
    "SELECT chunk_id FROM chunks WHERE project_id = ?",
  )
    .bind(projectId)
    .all<{ results?: Array<{ chunk_id: string }> }>()

  await deleteVectors(env, chunkRows.results || [])

  const docRows = await env.DB.prepare(
    "SELECT r2_key_raw, r2_key_text FROM documents WHERE project_id = ?",
  )
    .bind(projectId)
    .all<{ results?: Array<{ r2_key_raw?: string | null; r2_key_text?: string | null }> }>()

  await deleteR2Objects(env, docRows.results || [])
  await deleteR2Prefix(env, "projects/" + projectId + "/")

  await env.DB.prepare("DELETE FROM chat_logs WHERE project_id = ?").bind(projectId).run()
  await env.DB.prepare("DELETE FROM chunks WHERE project_id = ?").bind(projectId).run()
  await env.DB.prepare("DELETE FROM documents WHERE project_id = ?").bind(projectId).run()
  await env.DB.prepare("DELETE FROM projects WHERE project_id = ?").bind(projectId).run()

  return jsonResponse({ project_id: projectId, deleted: true })
}

/**
 * Creates a project from a JSON payload for a GitHub repo.
 */
async function handleJsonProjectCreate(request: Request, env: Env): Promise<Response> {
  const body = await request.json()
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400)
  }

  const payload = body as Record<string, unknown>
  const name = String(payload.name || "").trim()
  const projectId = ulid()
  const sourceRef = String(payload.source_ref || "").trim()

  if (!name || !sourceRef) {
    return jsonError("name and source_ref are required", 400)
  }

  if (!isValidProjectName(name)) {
    return jsonError("name must be alphanumeric with spaces or dashes", 400)
  }

  const nameLower = name.toLowerCase()
  const existing = await env.DB.prepare(
    "SELECT project_id FROM projects WHERE name_lower = ?",
  )
    .bind(nameLower)
    .first()
  if (existing) {
    return jsonError("Project name already exists", 409)
  }

  const created = await createProject(env, {
    project_id: projectId,
    source_type: "github",
    source_ref: sourceRef,
    name: name,
    name_lower: nameLower,
  })

  if (!created.ok) {
    return jsonError(created.error, created.status)
  }

  try {
    const workflowId = await triggerWorkflow(env, created.indexRequest)
    return jsonResponse({ project_id: projectId, name: name, workflow_id: workflowId })
  } catch (error) {
    void error
    return jsonError("Failed to start workflow", 500)
  }
}

/**
 * Inserts a project row and returns the indexing input on success.
 */
async function createProject(
  env: Env,
  input: IndexRequest,
): Promise<{ ok: true; indexRequest: IndexRequest } | { ok: false; error: string; status: number }> {
  const now = new Date().toISOString()
  const projectInsert = env.DB.prepare(
    "INSERT INTO projects (project_id, name, name_lower, source_type, source_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )

  try {
    await projectInsert
      .bind(
        input.project_id,
        input.name || "",
        input.name_lower || "",
        input.source_type,
        input.source_ref,
        "indexing",
        now,
        now,
      )
      .run()
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return { ok: false, error: "Project already exists", status: 409 }
    }
    return { ok: false, error: "Failed to create project", status: 500 }
  }

  return { ok: true, indexRequest: input }
}

/**
 * Triggers the indexing workflow and returns the instance id.
 */
async function triggerWorkflow(env: Env, input: IndexRequest): Promise<string> {
  if (!env.WORKFLOWS || !env.WORKFLOWS.create) {
    throw new Error("Workflow binding unavailable")
  }

  const result = await env.WORKFLOWS.create({
    params: input,
  })

  if (result && result.id) {
    return result.id
  }

  throw new Error("Workflow did not return an id")
}

function extractProjectId(requestUrl: string): string | null {
  const url = new URL(requestUrl)
  const parts = url.pathname.split("/")
  if (parts.length < 4) {
    return null
  }
  return parts[3] || null
}

function isValidProjectName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) {
    return false
  }
  return /^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(trimmed)
}

async function deleteVectors(
  env: Env,
  rows: Array<{ chunk_id: string }>,
): Promise<void> {
  if (!env.VECTORIZE_INDEX) {
    console.warn("[projects] vector delete skipped", { reason: "binding unavailable" })
    return
  }
  if (!env.VECTORIZE_INDEX.deleteByIds) {
    console.warn("[projects] vector delete skipped", {
      reason: "deleteByIds not available on binding",
    })
    return
  }

  const batchSize = 100
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map(function (row) {
      return row.chunk_id
    })
    await env.VECTORIZE_INDEX.deleteByIds(batch)
    console.log("[projects] vectors deleted", { count: batch.length, ids: batch })
  }
}

async function deleteR2Objects(
  env: Env,
  rows: Array<{ r2_key_raw?: string | null; r2_key_text?: string | null }>,
): Promise<void> {
  for (const row of rows) {
    if (row.r2_key_raw) {
      await env.DOCS_BUCKET.delete(row.r2_key_raw)
    }
    if (row.r2_key_text) {
      await env.DOCS_BUCKET.delete(row.r2_key_text)
    }
  }
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined = undefined
  do {
    const listResult = await env.DOCS_BUCKET.list({ prefix: prefix, cursor: cursor })
    for (const obj of listResult.objects) {
      await env.DOCS_BUCKET.delete(obj.key)
    }
    cursor = listResult.cursor
  } while (cursor)
}

interface ProjectRow {
  project_id: string
  name: string
  source_ref: string
  status: string
  created_at: string
  updated_at: string
}

/**
 * Returns a JSON response with 200 status.
 */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  })
}

/**
 * Returns a JSON error response with the given status code.
 */
function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: {
      "content-type": "application/json",
    },
  })
}
