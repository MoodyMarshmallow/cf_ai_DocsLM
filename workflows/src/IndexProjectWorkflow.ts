import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers"
import type { WorkflowEvent } from "cloudflare:workers"
import { chunkText } from "../../packages/shared/src/chunking"
import { sha256Hex } from "../../packages/shared/src/hash"
import { normalizeHtmlToText, normalizeMarkdownToText } from "../../packages/shared/src/normalization"
import { Env, IndexRequest } from "../../packages/shared/src/types"

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"

export class IndexProjectWorkflow extends WorkflowEntrypoint<Env, IndexRequest> {
  async run(event: WorkflowEvent<IndexRequest>, step: WorkflowStep): Promise<void> {
    try {
      const input = event.payload
      const env = this.env
      await step.do("mark project indexing", async function () {
        await markProjectStatus(env, input, "indexing")
      })

      const sources = await step.do("discover sources", async function () {
        return discoverSources(env, input)
      })

      for (const source of sources) {
        await step.do("process source", async function () {
          await processSource(env, input, source)
        })
      }

      await step.do("mark project ready", async function () {
        await markProjectStatus(env, input, "ready")
      })
    } catch (error) {
      void error
      await markProjectStatus(this.env, event.payload, "failed")
    }
  }
}

async function discoverSources(env: Env, input: IndexRequest): Promise<SourceItem[]> {
  if (input.source_type === "sitemap") {
    return discoverSitemapSources(input.source_ref)
  }
  if (input.source_type === "github") {
    return discoverGithubSources(input.source_ref)
  }
  if (input.source_type === "upload") {
    return discoverUploadSources(env, input.source_ref)
  }
  return []
}

async function discoverSitemapSources(sitemapUrl: string): Promise<SourceItem[]> {
  const targetUrl = sitemapUrl.endsWith(".xml") ? sitemapUrl : sitemapUrl.replace(/\/$/, "") + "/sitemap.xml"
  const response = await fetch(targetUrl)
  const xml = await response.text()
  const urls = parseSitemapXml(xml)
  return urls.map(function (url) {
    return { url: url, source_type: "sitemap" }
  })
}

function parseSitemapXml(xml: string): string[] {
  const urls: string[] = []
  const regex = /<loc>(.*?)<\/loc>/g
  let match = regex.exec(xml)
  while (match) {
    urls.push(match[1])
    match = regex.exec(xml)
  }
  return urls
}

async function discoverGithubSources(repoUrl: string): Promise<SourceItem[]> {
  const parsed = parseGithubRepo(repoUrl)
  if (!parsed) {
    return []
  }

  const results: SourceItem[] = []
  const readmeUrl = "https://api.github.com/repos/" + parsed.owner + "/" + parsed.repo + "/readme"
  const readme = await fetchGithubContent(readmeUrl)
  if (readme) {
    results.push({ url: readme, source_type: "github" })
  }

  const docsUrl =
    "https://api.github.com/repos/" + parsed.owner + "/" + parsed.repo + "/contents/docs"
  const docs = await fetchGithubDirectory(docsUrl)
  for (const doc of docs) {
    results.push({ url: doc, source_type: "github" })
  }

  return results
}

function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/)
  if (!match) {
    return null
  }
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") }
}

async function fetchGithubContent(apiUrl: string): Promise<string | null> {
  const response = await fetch(apiUrl)
  if (!response.ok) {
    return null
  }
  const data = await response.json()
  if (data && data.download_url) {
    return data.download_url
  }
  return null
}

async function fetchGithubDirectory(apiUrl: string): Promise<string[]> {
  const response = await fetch(apiUrl)
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

async function discoverUploadSources(env: Env, sourceRef: string): Promise<SourceItem[]> {
  const prefix = sourceRef.replace("r2://", "")
  const listResult = await env.DOCS_BUCKET.list({ prefix: prefix })
  return listResult.objects.map(function (obj) {
    return { url: obj.key, source_type: "upload" }
  })
}

async function processSource(env: Env, input: IndexRequest, source: SourceItem): Promise<void> {
  const fetchResult = await fetchSource(env, source)
  if (!fetchResult.ok) {
    return
  }

  const normalized = normalizeContent(fetchResult)
  if (!normalized.ok) {
    return
  }

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

  const chunks = chunkText(normalized.text, { max_chars: 4000, overlap_chars: 400 })
  for (const chunk of chunks) {
    await processChunk(env, input, document, chunk)
  }
}

async function fetchSource(env: Env, source: SourceItem): Promise<FetchResult> {
  if (source.source_type === "upload") {
    const r2Key = source.url
    const object = await env.DOCS_BUCKET.get(r2Key)
    if (!object) {
      return { ok: false, error: "R2 object not found" }
    }
    const text = await object.text()
    return {
      ok: true,
      url: r2Key,
      content_type: object.httpMetadata?.contentType || "text/plain",
      raw_text: text,
      r2_key_raw: r2Key,
      r2_key_text: undefined,
    }
  }

  const response = await fetch(source.url)
  if (!response.ok) {
    return { ok: false, error: "Failed to fetch source" }
  }
  const contentType = response.headers.get("content-type") || "text/plain"
  const rawText = await response.text()

  const rawKey = "raw/" + encodeURIComponent(source.url)
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

async function processChunk(
  env: Env,
  input: IndexRequest,
  document: DocumentInsert,
  chunk: { text: string; heading_path?: string; chunk_index: number; token_estimate: number },
): Promise<void> {
  const chunkId = await sha256Hex(document.doc_id + String(chunk.chunk_index))
  const vector = await embedText(env, chunk.text)

  await upsertVector(env, chunkId, vector, {
    project_id: input.project_id,
    doc_id: document.doc_id,
    url: document.url,
    heading: chunk.heading_path || "",
  })

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
}

async function embedText(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run(EMBEDDING_MODEL, { text: [text] })
  const parsed = result as { data?: number[][] }
  if (parsed && parsed.data && parsed.data[0]) {
    return parsed.data[0]
  }
  return []
}

async function upsertVector(
  env: Env,
  chunkId: string,
  vector: number[],
  metadata: Record<string, string>,
): Promise<void> {
  if (!env.VECTORIZE_INDEX || !env.VECTORIZE_INDEX.upsert) {
    return
  }
  await env.VECTORIZE_INDEX.upsert([{ id: chunkId, values: vector, metadata: metadata }])
}

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

async function markProjectStatus(env: Env, input: IndexRequest, status: string): Promise<void> {
  const statement = env.DB.prepare(
    "UPDATE projects SET status = ?, updated_at = ? WHERE project_id = ?",
  )
  await statement.bind(status, new Date().toISOString(), input.project_id).run()
}

interface SourceItem {
  url: string
  source_type: "sitemap" | "github" | "upload"
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
