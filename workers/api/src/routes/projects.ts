import { Env, IndexRequest, SourceType } from "../../../../packages/shared/src/types"

/**
 * Routes project creation requests to JSON or multipart handlers.
 */
export async function handleProjectCreate(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") || ""

  if (contentType.includes("multipart/form-data")) {
    return handleMultipartProjectCreate(request, env)
  }

  return handleJsonProjectCreate(request, env)
}

/**
 * Creates a project from a JSON payload for sitemap or GitHub sources.
 */
async function handleJsonProjectCreate(request: Request, env: Env): Promise<Response> {
  const body = await request.json()
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400)
  }

  const payload = body as Record<string, unknown>
  const projectId = String(payload.project_id || "").trim()
  const sourceType = payload.source_type
  const sourceRef = String(payload.source_ref || "").trim()

  if (!projectId || !sourceType || !sourceRef) {
    return jsonError("project_id, source_type, and source_ref are required", 400)
  }

  if (!isSourceType(sourceType)) {
    return jsonError("source_type must be sitemap, github, or upload", 400)
  }

  const typedSourceType = sourceType as SourceType

  if (sourceType === "upload") {
    return jsonError("Upload requires multipart form data", 400)
  }

  const created = await createProject(env, {
    project_id: projectId,
    source_type: typedSourceType,
    source_ref: sourceRef,
  })

  if (!created.ok) {
    return jsonError(created.error, created.status)
  }

  try {
    const workflowId = await triggerWorkflow(env, created.indexRequest)
    return jsonResponse({ project_id: projectId, workflow_id: workflowId })
  } catch (error) {
    void error
    return jsonError("Failed to start workflow", 500)
  }
}

/**
 * Creates a project from uploaded files via multipart form data.
 */
async function handleMultipartProjectCreate(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData()
  const projectId = String(formData.get("project_id") || "").trim()

  if (!projectId) {
    return jsonError("project_id is required", 400)
  }

  const uploadPrefix = "projects/" + projectId + "/uploads/"
  const files = collectFiles(formData)

  if (files.length === 0) {
    return jsonError("No files provided", 400)
  }

  for (const file of files) {
    const key = uploadPrefix + file.name
    await env.DOCS_BUCKET.put(key, file)
  }

  const created = await createProject(env, {
    project_id: projectId,
    source_type: "upload",
    source_ref: "r2://" + uploadPrefix,
  })

  if (!created.ok) {
    return jsonError(created.error, created.status)
  }

  try {
    const workflowId = await triggerWorkflow(env, created.indexRequest)
    return jsonResponse({ project_id: projectId, workflow_id: workflowId })
  } catch (error) {
    void error
    return jsonError("Failed to start workflow", 500)
  }
}

/**
 * Collects all file fields from a multipart payload.
 */
function collectFiles(formData: FormData): File[] {
  const files: File[] = []
  for (const value of formData.values()) {
    if (value instanceof File) {
      files.push(value)
    }
  }
  return files
}

/**
 * Validates the supported source_type values.
 */
function isSourceType(value: unknown): value is SourceType {
  return value === "sitemap" || value === "github" || value === "upload"
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
    "INSERT INTO projects (project_id, source_type, source_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )

  try {
    await projectInsert
      .bind(input.project_id, input.source_type, input.source_ref, "indexing", now, now)
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
