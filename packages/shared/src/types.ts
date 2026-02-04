export type SourceType = "github"

export interface Env {
  AI: WorkersAIBinding
  DB: D1Database
  DOCS_BUCKET: R2Bucket
  VECTORIZE_INDEX: VectorizeBinding
  CHAT_SESSIONS: DurableObjectNamespace
  WORKFLOWS: WorkflowsBinding
  ENVIRONMENT: string
  EMBEDDING_MODEL: string
  CHAT_MODEL: string
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
}

export interface D1PreparedStatement {
  bind(...values: Array<string | number | null>): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = { results?: Array<Record<string, unknown>> }>(): Promise<T>
  run(): Promise<void>
}

export interface R2Bucket {
  put(key: string, value: string | ReadableStream | ArrayBuffer | Blob): Promise<void>
  get(key: string): Promise<R2ObjectBody | null>
  list(options: { prefix: string }): Promise<R2ObjectsList>
}

export interface R2ObjectBody {
  text(): Promise<string>
  httpMetadata?: { contentType?: string }
}

export interface R2ObjectsList {
  objects: Array<{ key: string }>
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

export type DurableObjectId = object

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

export interface WorkersAIBinding {
  run(model: string, input: unknown): Promise<unknown>
}

export interface VectorizeBinding {
  query?: (vector: number[], options: VectorizeQueryOptions) => Promise<VectorizeQueryResult>
  upsert?: (vectors: VectorizeUpsertItem[]) => Promise<void>
}

export interface VectorizeQueryOptions {
  topK: number
  filter?: Record<string, string>
}

export interface VectorizeQueryResult {
  matches?: VectorizeMatch[]
}

export interface VectorizeMatch {
  id: string
  score?: number
}

export interface VectorizeUpsertItem {
  id: string
  values: number[]
  metadata?: Record<string, string>
}

export interface WorkflowsBinding {
  create?: (input: { id?: string; params: IndexRequest }) => Promise<{ id?: string }>
}

export interface Project {
  project_id: string
  source_type: SourceType
  source_ref: string
  status: string
  owner_id_optional?: string
  created_at: string
  updated_at: string
}

export interface DocumentRecord {
  doc_id: string
  project_id: string
  url: string
  r2_key_raw?: string
  r2_key_text?: string
  content_hash: string
  title?: string
  updated_at: string
}

export interface ChunkRecord {
  chunk_id: string
  project_id: string
  doc_id: string
  url: string
  heading_path?: string
  chunk_index: number
  text: string
  content_hash: string
  token_estimate: number
}

export interface ChatTurn {
  role: "user" | "assistant" | "system"
  content: string
}

export interface ChatRequest {
  session_id?: string
  project_id: string
  message: string
}

export interface ChatResponse {
  session_id: string
  message: string
  citations: Array<{ url: string; heading_path?: string }>
}

export interface IndexRequest {
  project_id: string
  source_type: SourceType
  source_ref: string
}
