import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers"
import type { WorkflowEvent } from "cloudflare:workers"
import { chunkText } from "../../packages/shared/src/chunking"
import { sha256Hex } from "../../packages/shared/src/hash"
import { normalizeHtmlToText, normalizeMarkdownToText } from "../../packages/shared/src/normalization"
import { Env, IndexRequest, VectorizeUpsertItem } from "../../packages/shared/src/types"

export class IndexProjectWorkflow extends WorkflowEntrypoint<Env, IndexRequest> {
  /**
   * Runs the indexing workflow with durable steps for status, discovery, and processing.
   */
  async run(event: WorkflowEvent<IndexRequest>, step: WorkflowStep): Promise<void> {
    try {
      const input = event.payload
      const env = this.env
      const maxChunks = 500
      const maxUpsertBatchSize = 1000
      let remainingChunks = maxChunks
      let lastMutationId: string | null = null
      const pendingVectors: VectorizeUpsertItem[] = []
      await step.do("mark project indexing", async function () {
        await markProjectStatus(env, input, "indexing")
      })

      const sources = await step.do("discover sources", async function () {
        return discoverSources(input)
      })

      const sortedSources = sources.slice().sort(function (left, right) {
        return right.score - left.score
      })

      for (const source of sortedSources) {
        if (remainingChunks <= 0) {
          break
        }

        const processed = await step.do("process source", async function () {
          return processSource(env, input, source, remainingChunks, pendingVectors, maxUpsertBatchSize)
        })

        remainingChunks = Math.max(0, remainingChunks - processed.count)
        if (processed.lastMutationId) {
          lastMutationId = processed.lastMutationId
        }
      }

      if (pendingVectors.length > 0) {
        const mutationId = await step.do("upsert final vector batch", async function () {
          return upsertVectorBatch(env, pendingVectors)
        })
        if (mutationId) {
          lastMutationId = mutationId
        }
      }

      if (lastMutationId) {
        const ready = await step.do("wait for vectorize", async function () {
          return waitForVectorizeMutation(env, lastMutationId)
        })
        if (!ready) {
          console.error("[indexing] vectorize mutation timeout", {
            project_id: input.project_id,
            mutation_id: lastMutationId,
          })
          return
        }
      }

      await step.do("mark project ready", async function () {
        await markProjectStatus(env, input, "ready")
      })
      console.log("[indexing] project complete", { project_id: input.project_id })
    } catch (error) {
      await markProjectStatus(this.env, event.payload, "failed", {
        reason: "Unhandled indexing workflow error",
        error: error,
      })
    }
  }
}

/**
 * Resolves source URLs for the configured project source type.
 */
async function discoverSources(input: IndexRequest): Promise<SourceItem[]> {
  console.log("[indexing] discovering sources", {
    project_id: input.project_id,
    source_type: input.source_type,
    source_ref: input.source_ref,
  })

  return discoverGithubSources(input.source_ref)
}


/**
 * Discovers README and docs/ files for a GitHub repository.
 */
async function discoverGithubSources(repoUrl: string): Promise<SourceItem[]> {
  const parsed = parseGithubRepo(repoUrl)
  if (!parsed) {
    console.log("[indexing] github parse failed", { repo_url: repoUrl })
    return []
  }

  const defaultBranch = await fetchGithubDefaultBranch(parsed.owner, parsed.repo)
  if (!defaultBranch) {
    console.log("[indexing] github default branch missing", { repo: repoUrl })
    return []
  }

  const treeResult = await fetchGithubTree(parsed.owner, parsed.repo, defaultBranch)
  if (treeResult && treeResult.truncated) {
    console.log("[indexing] github tree truncated", { repo: repoUrl })
  }

  if (treeResult && treeResult.tree && treeResult.tree.length > 0 && !treeResult.truncated) {
    const filtered = filterGithubTree(treeResult.tree)
    const capped = filtered.slice(0, 100)
    const sources = capped.map(function (item) {
      return {
        url: buildGithubRawUrl(parsed.owner, parsed.repo, defaultBranch, item.path),
        source_type: "github" as const,
        score: item.score,
      }
    })

    console.log("[indexing] github sources", { count: sources.length, repo: repoUrl })
    return sources
  }

  const fallback = await discoverGithubFallback(parsed.owner, parsed.repo)
  console.log("[indexing] github sources", { count: fallback.length, repo: repoUrl })
  return fallback
}

/**
 * Parses a GitHub repository URL into owner/repo components.
 */
function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/)
  if (!match) {
    return null
  }
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") }
}

/**
 * Fetches a GitHub API content entry and returns its download URL.
 */
async function fetchGithubContent(apiUrl: string): Promise<string | null> {
  const response = await githubFetch(apiUrl)
  if (!response.ok) {
    return null
  }
  const data = (await response.json()) as { download_url?: string }
  if (data && data.download_url) {
    return data.download_url
  }
  return null
}

/**
 * Lists file download URLs from a GitHub directory endpoint.
 */
async function fetchGithubDirectory(apiUrl: string): Promise<string[]> {
  const response = await githubFetch(apiUrl)
  if (!response.ok) {
    return []
  }
  const data = await response.json()
  if (!Array.isArray(data)) {
    return []
  }

  const urls: string[] = []
  for (const item of data) {
    if (item && item.type === "file" && item.download_url) {
      urls.push(item.download_url)
    }
  }
  return urls
}

async function fetchGithubDefaultBranch(owner: string, repo: string): Promise<string | null> {
  const url = "https://api.github.com/repos/" + owner + "/" + repo
  const response = await githubFetch(url)
  if (!response.ok) {
    return null
  }
  const data = (await response.json()) as { default_branch?: string }
  if (data && data.default_branch) {
    return String(data.default_branch)
  }
  return null
}

async function fetchGithubTree(
  owner: string,
  repo: string,
  branch: string,
): Promise<{ tree: GithubTreeItem[]; truncated: boolean } | null> {
  const url =
    "https://api.github.com/repos/" + owner + "/" + repo + "/git/trees/" + branch + "?recursive=1"
  const response = await githubFetch(url)
  if (!response.ok) {
    return null
  }
  const data = (await response.json()) as { tree?: GithubTreeItem[]; truncated?: boolean }
  if (!data || !Array.isArray(data.tree)) {
    return null
  }
  return { tree: data.tree as GithubTreeItem[], truncated: Boolean(data.truncated) }
}

function filterGithubTree(items: GithubTreeItem[]): Array<GithubTreeItem & { score: number }> {
  const candidates = items.filter(function (item) {
    if (!item || item.type !== "blob" || !item.path) {
      return false
    }
    if (isIgnoredPath(item.path)) {
      return false
    }
    if (!isAllowedDocPath(item.path)) {
      return false
    }
    return true
  })

  const scored = candidates.map(function (item) {
    return { item: item, score: scoreDocPath(item.path) }
  })

  scored.sort(function (left, right) {
    return right.score - left.score
  })

  return scored.map(function (entry) {
    return { path: entry.item.path, type: entry.item.type, score: entry.score }
  })
}

function isAllowedDocPath(path: string): boolean {
  const lower = path.toLowerCase()
  const extensions = [
    ".md",
    ".mdx",
    ".rst",
    ".adoc",
    ".asciidoc",
    ".txt",
    ".text",
    ".mdown",
    ".markdown",
    ".mkd",
    ".mdwn",
  ]

  for (const ext of extensions) {
    if (lower.endsWith(ext)) {
      return true
    }
  }
  return false
}

function isIgnoredPath(path: string): boolean {
  const ignoredPrefixes = [
    "node_modules/",
    "dist/",
    "build/",
    "out/",
    ".next/",
    ".nuxt/",
    ".cache/",
    "coverage/",
    "vendor/",
    "tmp/",
    "logs/",
    "public/assets/",
    ".git/",
  ]

  for (const prefix of ignoredPrefixes) {
    if (path.startsWith(prefix)) {
      return true
    }
  }
  return false
}

function scoreDocPath(path: string): number {
  const lower = path.toLowerCase()
  let score = 0

  if (lower.includes("docs/")) {
    score += 5
  }
  if (lower.includes("guide") || lower.includes("guides/")) {
    score += 3
  }
  if (lower.includes("reference") || lower.includes("manual")) {
    score += 2
  }
  if (lower.includes("api/")) {
    score += 2
  }
  if (lower.includes("readme")) {
    score += 4
  }

  return score
}

function scoreSourceUrl(url: string): number {
  const path = extractPathFromUrl(url)
  return scoreDocPath(path)
}

function extractPathFromUrl(url: string): string {
  const raw = url.replace(/^r2:\/\//, "")
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      return new URL(raw).pathname.replace(/^\//, "")
    } catch (error) {
      void error
      return raw
    }
  }
  return raw
}

function buildGithubRawUrl(owner: string, repo: string, branch: string, path: string): string {
  return "https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + branch + "/" + path
}

function githubFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": "docs-lm",
      Accept: "application/vnd.github+json",
    },
  })
}

async function discoverGithubFallback(owner: string, repo: string): Promise<SourceItem[]> {
  const results: SourceItem[] = []
  const readmeUrl = "https://api.github.com/repos/" + owner + "/" + repo + "/readme"
  const readme = await fetchGithubContent(readmeUrl)
  if (readme) {
    results.push({ url: readme, source_type: "github", score: scoreSourceUrl(readme) })
  }

  const docsUrl = "https://api.github.com/repos/" + owner + "/" + repo + "/contents/docs"
  const docs = await fetchGithubDirectory(docsUrl)
  for (const doc of docs) {
    results.push({ url: doc, source_type: "github", score: scoreSourceUrl(doc) })
  }

  return results
}

/**
 * Fetches, normalizes, chunks, embeds, and stores a single source document.
 */
async function processSource(
  env: Env,
  input: IndexRequest,
  source: SourceItem,
  remainingChunks: number,
  pendingVectors: VectorizeUpsertItem[],
  maxUpsertBatchSize: number,
): Promise<{ count: number; lastMutationId: string | null; vectorsCreated: number }> {
  if (remainingChunks <= 0) {
    return { count: 0, lastMutationId: null, vectorsCreated: 0 }
  }

  const fetchResult = await fetchSource(env, source, input.project_id)
  if (!fetchResult.ok) {
    return { count: 0, lastMutationId: null, vectorsCreated: 0 }
  }

  const normalized = normalizeContent(fetchResult)
  if (!normalized.ok) {
    return { count: 0, lastMutationId: null, vectorsCreated: 0 }
  }

  logContentPreview(input.project_id, fetchResult.url, normalized.text)

  const contentHash = await sha256Hex(normalized.text)
  const docId = await sha256Hex(input.project_id + fetchResult.url)

  const document: DocumentInsert = {
    doc_id: docId,
    project_id: input.project_id,
    url: fetchResult.url,
    r2_key_raw: fetchResult.r2_key_raw,
    r2_key_text: fetchResult.r2_key_text,
    content_hash: contentHash,
    title: undefined,
    updated_at: new Date().toISOString(),
  }

  await upsertDocument(env, document)

  const chunks = chunkText(normalized.text, { max_chars: 8000, overlap_chars: 800, min_chars: 500 })
  const cappedChunks = chunks.slice(0, Math.max(0, remainingChunks))
  let vectorsCreated = 0
  let lastMutationId: string | null = null

  for (const chunk of cappedChunks) {
    const vectorItem = await processChunk(env, input, document, chunk)
    if (vectorItem) {
      vectorsCreated += 1
      pendingVectors.push(vectorItem)
    }

    if (pendingVectors.length >= maxUpsertBatchSize) {
      const batch = pendingVectors.splice(0, maxUpsertBatchSize)
      const mutationId = await upsertVectorBatch(env, batch)
      if (mutationId) {
        lastMutationId = mutationId
      }
    }
  }

  console.log("[indexing] source processed", {
    project_id: input.project_id,
    source_url: source.url,
    chunks_processed: cappedChunks.length,
    vectors_created: vectorsCreated,
  })

  return { count: cappedChunks.length, lastMutationId: lastMutationId, vectorsCreated: vectorsCreated }
}

/**
 * Loads a source document from R2 or HTTP and stores raw content in R2.
 */
async function fetchSource(env: Env, source: SourceItem, projectId: string): Promise<FetchResult> {
  const response = await fetch(source.url)
  if (!response.ok) {
    return { ok: false, error: "Failed to fetch source" }
  }
  const contentType = response.headers.get("content-type") || "text/plain"
  const rawText = await response.text()

  const rawKey = "projects/" + projectId + "/raw/" + encodeURIComponent(source.url)
  await env.DOCS_BUCKET.put(rawKey, rawText)

  return {
    ok: true,
    url: source.url,
    content_type: contentType,
    raw_text: rawText,
    r2_key_raw: rawKey,
    r2_key_text: undefined,
  }
}

/**
 * Normalizes raw content into plain text, rejecting unsupported types.
 */
function normalizeContent(fetchResult: FetchResult): NormalizeResult {
  if (!fetchResult.ok) {
    return { ok: false, error: "Fetch failed" }
  }

  const contentType = fetchResult.content_type.toLowerCase()
  if (contentType.includes("pdf")) {
    return { ok: false, error: "PDF unsupported" }
  }

  if (contentType.includes("html")) {
    return { ok: true, text: normalizeHtmlToText(fetchResult.raw_text) }
  }

  return { ok: true, text: normalizeMarkdownToText(fetchResult.raw_text) }
}

/**
 * Embeds a chunk, persists chunk text, and returns vector payload for batch upsert.
 */
async function processChunk(
  env: Env,
  input: IndexRequest,
  document: DocumentInsert,
  chunk: { text: string; heading_path?: string; chunk_index: number; token_estimate: number },
): Promise<VectorizeUpsertItem | null> {
  const chunkId = await sha256Hex(document.doc_id + String(chunk.chunk_index))
  const vector = await embedText(env, chunk.text)

  if (vector.length === 0) {
    console.warn("[indexing] empty embedding returned for chunk", {
      project_id: input.project_id,
      chunk_id: chunkId,
      chunk_index: chunk.chunk_index,
      url: document.url,
    })
  }

  await upsertChunk(env, {
    chunk_id: chunkId,
    project_id: input.project_id,
    doc_id: document.doc_id,
    url: document.url,
    heading_path: chunk.heading_path,
    chunk_index: chunk.chunk_index,
    text: chunk.text,
    content_hash: await sha256Hex(chunk.text),
    token_estimate: chunk.token_estimate,
  })

  if (vector.length === 0) {
    return null
  }

  return {
    id: chunkId,
    values: vector,
    metadata: {
      project_id: input.project_id,
      doc_id: document.doc_id,
      url: document.url,
      heading: chunk.heading_path || "",
    },
  }
}

/**
 * Generates an embedding for the given text using Workers AI.
 */
async function embedText(env: Env, text: string): Promise<number[]> {
  if (!env.AI) {
    console.warn("[indexing] embedding skipped", { reason: "binding unavailable" })
    return []
  }
  if (!env.AI.run) {
    console.warn("[indexing] embedding skipped", { reason: "run not available on binding" })
    return []
  }
  const result = await env.AI.run(env.EMBEDDING_MODEL, { text: [text] })
  const parsed = result as { data?: number[][] }
  if (parsed && parsed.data && parsed.data[0]) {
    return parsed.data[0]
  }
  console.warn("[indexing] embedding missing", { reason: "no data returned" })
  return []
}

/**
 * Upserts a batch of vectors with metadata into Vectorize.
 */
async function upsertVectorBatch(
  env: Env,
  vectors: VectorizeUpsertItem[],
): Promise<string | null> {
  if (vectors.length === 0) {
    return null
  }

  if (!env.VECTORIZE_INDEX) {
    console.warn("[indexing] vector upsert skipped", { reason: "binding unavailable" })
    return null
  }

  if (!env.VECTORIZE_INDEX.upsert) {
    console.warn("[indexing] vector upsert skipped", {
      reason: "upsert not available on binding",
    })
    return null
  }

  const result = await env.VECTORIZE_INDEX.upsert(vectors)
  console.log("[indexing] vectors upserted", {
    count: vectors.length,
    first_id: vectors[0].id,
    last_id: vectors[vectors.length - 1].id,
  })

  if (result && result.mutationId) {
    return result.mutationId
  }

  console.warn("[indexing] vector upsert returned without mutation id", {
    count: vectors.length,
  })
  return null
}

async function waitForVectorizeMutation(env: Env, mutationId: string): Promise<boolean> {
  if (!env.VECTORIZE_INDEX) {
    console.warn("[indexing] mutation wait skipped", { reason: "binding unavailable" })
    return false
  }
  if (!env.VECTORIZE_INDEX.describe) {
    console.warn("[indexing] mutation wait skipped", { reason: "describe not available on binding" })
    return false
  }

  const maxAttempts = 60
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const info = await env.VECTORIZE_INDEX.describe()
    if (info && info.processedUpToMutation === mutationId) {
      console.log("[indexing] vectorize mutation processed", { mutation_id: mutationId })
      return true
    }
    console.log("[indexing] vectorize mutation polled", { mutation_id: mutationId, processedUpToMutation: info.processedUpToMutation, vectorCount: info.vectorCount})
    await sleep(5000)
  }

  console.error("[indexing] vectorize mutation wait timed out", { mutation_id: mutationId })
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

/**
 * Inserts or updates a document record in D1.
 */
async function upsertDocument(env: Env, doc: DocumentInsert): Promise<void> {
  const statement = env.DB.prepare(
    "INSERT OR REPLACE INTO documents (doc_id, project_id, url, r2_key_raw, r2_key_text, content_hash, title, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
  await statement
    .bind(
      doc.doc_id,
      doc.project_id,
      doc.url,
      doc.r2_key_raw || null,
      doc.r2_key_text || null,
      doc.content_hash,
      doc.title || null,
      doc.updated_at,
    )
    .run()
}

/**
 * Inserts or updates a chunk record in D1.
 */
async function upsertChunk(env: Env, chunk: ChunkInsert): Promise<void> {
  const statement = env.DB.prepare(
    "INSERT OR REPLACE INTO chunks (chunk_id, project_id, doc_id, url, heading_path, chunk_index, text, content_hash, token_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  await statement
    .bind(
      chunk.chunk_id,
      chunk.project_id,
      chunk.doc_id,
      chunk.url,
      chunk.heading_path || null,
      chunk.chunk_index,
      chunk.text,
      chunk.content_hash,
      chunk.token_estimate,
    )
    .run()
}

/**
 * Updates the project status in D1.
 */
async function markProjectStatus(
  env: Env,
  input: IndexRequest,
  status: string,
  context?: { reason?: string; error?: unknown },
): Promise<void> {
  if (status === "failed") {
    const reason = context && context.reason ? context.reason : "Project marked failed"
    const errorMessage =
      context && context.error
        ? context.error instanceof Error
          ? context.error.stack || context.error.message
          : String(context.error)
        : "unknown error"
    console.error("[indexing] project failed", {
      project_id: input.project_id,
      source_ref: input.source_ref,
      reason: reason,
      error: errorMessage,
    })
  }

  const statement = env.DB.prepare(
    "UPDATE projects SET status = ?, updated_at = ? WHERE project_id = ?",
  )
  await statement.bind(status, new Date().toISOString(), input.project_id).run()
}

/**
 * Logs the content source and a short preview for debugging indexing.
 */
function logContentPreview(projectId: string, sourceUrl: string, text: string): void {
  const previewLength = 160
  const preview = text.slice(0, previewLength).replace(/\s+/g, " ").trim()
  const message =
    "[indexing] project=" +
    projectId +
    " source=" +
    sourceUrl +
    " preview=\"" +
    preview +
    "\""
  console.log(message)
}

interface SourceItem {
  url: string
  source_type: "github"
  score: number
}

interface GithubTreeItem {
  path: string
  type: string
}

interface FetchResultOk {
  ok: true
  url: string
  content_type: string
  raw_text: string
  r2_key_raw?: string
  r2_key_text?: string
}

interface FetchResultError {
  ok: false
  error: string
}

type FetchResult = FetchResultOk | FetchResultError

interface NormalizeResultOk {
  ok: true
  text: string
}

interface NormalizeResultError {
  ok: false
  error: string
}

type NormalizeResult = NormalizeResultOk | NormalizeResultError

interface DocumentInsert {
  doc_id: string
  project_id: string
  url: string
  r2_key_raw?: string
  r2_key_text?: string
  content_hash: string
  title?: string
  updated_at: string
}

interface ChunkInsert {
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
