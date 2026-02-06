import { SYSTEM_PROMPT } from "../../../packages/shared/src/prompts"
import {
  ChatRequest,
  ChatResponse,
  Env,
  ChatTurn,
  VectorizeMatch,
  VectorizeQueryResult,
} from "../../../packages/shared/src/types"

interface SessionState {
  summary: string
  turns: ChatTurn[]
  project_id?: string
}

interface ChatRequestWithSession extends ChatRequest {
  session_id: string
}

interface DurableObjectState {
  storage: DurableObjectStorage
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T = unknown>(key: string, value: T): Promise<void>
}

export class ChatSessionDO {
  private state: DurableObjectState
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405)
    }

    const body = await request.json()
    const parsed = parseChatRequest(body)
    if (!parsed.ok) {
      return jsonError(parsed.error, 400)
    }

    const session = await this.loadState()
    if (!session.project_id) {
      session.project_id = parsed.value.project_id
      await this.state.storage.put("project_id", session.project_id)
    }

    const retrieval = await this.retrieveContext(parsed.value, session)
    logRetrievalContext(parsed.value.project_id, retrieval)
    const responseText = await this.generateResponse(parsed.value, session, retrieval)

    session.turns.push({ role: "user", content: parsed.value.message })
    session.turns.push({ role: "assistant", content: responseText })
    session.summary = updateSummary(session.summary, responseText)

    await this.state.storage.put("turns", session.turns)
    await this.state.storage.put("summary", session.summary)

    const response: ChatResponse = {
      session_id: parsed.value.session_id,
      message: responseText,
      citations: retrieval.citations,
    }

    return jsonResponse(response)
  }

  private async loadState(): Promise<SessionState> {
    const summary = (await this.state.storage.get("summary")) as string | undefined
    const turns = (await this.state.storage.get("turns")) as ChatTurn[] | undefined
    const projectId = (await this.state.storage.get("project_id")) as string | undefined

    return {
      summary: summary || "",
      turns: turns || [],
      project_id: projectId,
    }
  }

  private async retrieveContext(
    request: ChatRequestWithSession,
    session: SessionState,
  ): Promise<{ context: string; citations: Array<{ url: string; heading_path?: string }> }> {
    const vector = await embedText(this.env, request.message)
    const matches = await queryVectorize(this.env, vector, {
      project_id: session.project_id || request.project_id,
    })

    console.log("[chat] vectorize matches", {
      project_id: session.project_id || request.project_id,
      match_count: matches.length,
    })

    if (matches.length === 0) {
      return { context: "", citations: [] }
    }

    const chunkIds = matches.map(function (match: VectorizeMatch) {
      return String(match.id)
    })

    const rows = await fetchChunksByIds(this.env, chunkIds)
    console.log("[chat] chunk fetch", {
      chunk_ids: chunkIds.length,
      rows: rows.length,
    })
    const citations = rows.map(function (row) {
      return { url: row.url, heading_path: row.heading_path || undefined }
    })

    const context = rows
      .map(function (row) {
        return row.text
      })
      .join("\n\n")

    return { context: context, citations: citations }
  }

  private async generateResponse(
    request: ChatRequestWithSession,
    session: SessionState,
    retrieval: { context: string; citations: Array<{ url: string; heading_path?: string }> },
  ): Promise<string> {
    if (!retrieval.context) {
      return "I could not find relevant context in the indexed docs. Please check the project or try a different query."
    }

    const messages = buildMessages(session, request, retrieval.context)
    if (!this.env.AI) {
      console.warn("[chat] ai run skipped", { reason: "binding unavailable" })
      return "The model did not return a response."
    }
    if (!this.env.AI.run) {
      console.warn("[chat] ai run skipped", { reason: "run not available on binding" })
      return "The model did not return a response."
    }
    const result = await this.env.AI.run(this.env.CHAT_MODEL, { messages: messages })
    const extracted = extractChatContent(result)
    if (extracted) {
      return extracted
    }
    logChatResult(result)
    return "The model did not return a response."
  }
}

function parseChatRequest(
  body: unknown,
): { ok: true; value: ChatRequestWithSession } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid JSON body" }
  }

  const payload = body as Record<string, unknown>

  if (!payload.session_id || !payload.project_id || !payload.message) {
    return { ok: false, error: "session_id, project_id, and message are required" }
  }
  return {
    ok: true,
    value: {
      session_id: String(payload.session_id),
      project_id: String(payload.project_id),
      message: String(payload.message),
    },
  }
}

async function embedText(env: Env, text: string): Promise<number[]> {
  if (!env.AI) {
    console.warn("[chat] embedding skipped", { reason: "binding unavailable" })
    return []
  }
  if (!env.AI.run) {
    console.warn("[chat] embedding skipped", { reason: "run not available on binding" })
    return []
  }
  const result = await env.AI.run(env.EMBEDDING_MODEL, { text: [text] })
  const parsed = result as { data?: number[][] }
  if (parsed && parsed.data && parsed.data[0]) {
    return parsed.data[0]
  }
  console.warn("[chat] embedding missing", { reason: "no data returned" })
  return []
}

async function queryVectorize(
  env: Env,
  vector: number[],
  filters: { project_id: string },
): Promise<VectorizeMatch[]> {
  if (!env.VECTORIZE_INDEX) {
    console.warn("[chat] vector query skipped", {reason: "binding not available"})
    return []
  }

  if (!env.VECTORIZE_INDEX.query) {
    console.warn("[chat] vector query skipped", {reason: "query function not available on binding"})
    return []
  }

  const filter: Record<string, string> = {
    project_id: filters.project_id,
  }
  
  const result = (await env.VECTORIZE_INDEX.query(vector, {
    topK: 6,
    filter: filter,
  })) as VectorizeQueryResult

  try {
    console.log("[chat] vectorize result", JSON.stringify(result))
  } catch (error) {
    void error
    console.log("[chat] vectorize result", "[unserializable]")
  }

  if (result && result.matches) {
    return result.matches
  }

  return []
}

async function fetchChunksByIds(env: Env, chunkIds: string[]): Promise<ChunkRow[]> {
  if (chunkIds.length === 0) {
    return []
  }

  const placeholders = chunkIds.map(function () {
    return "?"
  })
  const sql =
    "SELECT chunk_id, text, url, heading_path FROM chunks WHERE chunk_id IN (" +
    placeholders.join(",") +
    ")"

  const statement = env.DB.prepare(sql)
  const result = await statement.bind(...chunkIds).all<{ results?: ChunkRow[] }>()
  return result.results || []
}

function buildMessages(session: SessionState, request: ChatRequest, context: string): ChatTurn[] {
  const messages: ChatTurn[] = []
  messages.push({ role: "system", content: SYSTEM_PROMPT })
  if (session.summary) {
    messages.push({ role: "system", content: "Summary: " + session.summary })
  }

  const recentTurns = session.turns.slice(-6)
  for (const turn of recentTurns) {
    messages.push({ role: turn.role, content: turn.content })
  }

  messages.push({ role: "system", content: "Context:\n" + context })
  messages.push({ role: "user", content: request.message })
  return messages
}

function updateSummary(existing: string, latestResponse: string): string {
  if (!existing) {
    return latestResponse.slice(0, 500)
  }
  const combined = existing + " " + latestResponse
  if (combined.length > 1000) {
    return combined.slice(combined.length - 1000)
  }
  return combined
}

function logRetrievalContext(
  projectId: string,
  retrieval: { context: string; citations: Array<{ url: string; heading_path?: string }> },
): void {
  const previewLength = 200
  const preview = retrieval.context.slice(0, previewLength).replace(/\s+/g, " ").trim()
  console.log("[chat] retrieval context", {
    project_id: projectId,
    has_context: Boolean(retrieval.context),
    citations: retrieval.citations.length,
    preview: preview,
  })
}

function logChatResult(result: unknown): void {
  let message = "[chat] chat result: "
  if (typeof result === "string") {
    message += result
  } else {
    try {
      message += JSON.stringify(result)
    } catch (error) {
      void error
      message += "[unserializable result]"
    }
  }
  console.log(message)
}

function extractChatContent(result: unknown): string | null {
  if (typeof result === "string") {
    return result
  }
  if (!result || typeof result !== "object") {
    return null
  }

  const payload = result as {
    response?: string
    choices?: Array<{ message?: { content?: string } }>
  }

  if (payload.response) {
    return String(payload.response)
  }

  if (payload.choices && payload.choices[0] && payload.choices[0].message?.content) {
    return String(payload.choices[0].message.content)
  }

  return null
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

interface ChunkRow {
  chunk_id: string
  text: string
  url: string
  heading_path?: string | null
}
