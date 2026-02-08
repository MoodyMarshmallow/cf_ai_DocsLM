# DocsLM: Turn Any Large Body of Text Into a Chatbot
## Problem Description
I often find myself having to quickly learn a large chunk of information, and a lot of the time that information is presented to me as a large body of text or code. While this is great at giving me detailed information, I often struggle to get a high-level view of the content.

DocsLM makes this body of text an interactive experience, complete with a bunch of useful tools like a chatbot, mind maps, and quizzes that helps me quickly understand the content holistically.
## Goals
### Current Goals
Make a webapp that generates a chatbot from a given URL of a public GitHub repo. This is done by:
1. Indexing the webpage/document
2. Store in vector DB
3. Wire tool to model to retrieve relevant information
### Stretch Goals
1. Make RAG better
- Implement techniques like SELF-RAG
- Improve chunking with techniques like semantic chunking and support multimodal content
- Improve retrieval with techniques like fusion retrieval and re-rankers
2. Build more user-facing features
- Mind map
- Quiz generator
3. Add more ingestion methods
- Sitemap-based crawling
- Direct file uploads to R2
- PDF ingestion
- Other text-based sources
## Technical Details
### Project file structure overview
This section describes the intended layout for a Cloudflare-first implementation. The exact structure can be adapted, but the modules below are the expected logical boundaries.

```ts
.
├─ apps/
│  └─ web/
│     └─ src/
│        ├─ pages/
│        │  ├─ index.tsx                   // Project list + chat UI shell
│        │  └─ project/
│        │     └─ [project_id].tsx         // Project view: sessions and chat
│        ├─ components/
│        │  ├─ ChatPanel.tsx               // Chat UI and streaming message list
│        │  ├─ ProjectCreate.tsx           // Create project and upload docs
│        └─ lib/
│           ├─ api.ts                      // API client for Worker routes
│           └─ session.ts                  // session_id storage and WS/SSE helpers
├─ workers/
│  ├─ api/
│  │  └─ src/
│  │     ├─ index.ts                       // HTTP router and auth/rate limiting
│  │     └─ routes/
│  │        ├─ chat.ts                     // POST /api/chat entrypoint
│  │        ├─ indexing.ts                 // POST /api/index/start + GET /api/index/status
│  │        └─ projects.ts                 // Project creation and upload bootstrap
│  └─ durable-objects/
│     └─ src/
│        └─ ChatSessionDO.ts               // Session state, retrieval, LLM calls, streaming
├─ workflows/
│  └─ src/
│     └─ IndexProjectWorkflow.ts           // Discover, fetch, normalize, chunk, embed, upsert
├─ packages/
│  └─ shared/
│     └─ src/
│        ├─ types.ts                       // Shared types for requests, responses, and data models
│        ├─ prompts.ts                     // System prompt templates and guardrails
│        └─ chunking.ts                    // Chunking utilities and config
└─ wrangler.jsonc                          // Bindings for AI, Vectorize, D1, R2, DO, Workflows
```

### Data models and Schema Definitions
The system uses a mix of D1, Vectorize, R2, and Durable Objects storage to meet the requirements.

```ts
const D1_TABLES = {
    "projects": [
        "project_id (ulid)",
        "name (unique, case-insensitive)",
        "name_lower",
        "source_type",
        "source_ref",
        "status",
        "owner_id_optional",
        "created_at",
        "updated_at",
    ],
    "documents": [
        "doc_id",
        "project_id",
        "url",
        "r2_key_raw",
        "r2_key_text",
        "content_hash",
        "title",
        "updated_at",
    ],
    "chunks": [
        "chunk_id",
        "doc_id",
        "project_id",
        "url",
        "heading_path",
        "chunk_index",
        "text_optional",
        "content_hash",
        "token_estimate",
    ],
    "chat_logs_optional": [
        "session_id",
        "project_id",
        "turn_id",
        "role",
        "content",
        "created_at",
    ],
} as const

const VECTORIZE_INDEX = {
    "name": "docs_chunks",
  "vector_per_chunk": true,
  "metadata": {
    "project_id": {"indexed": true},
    "doc_id": {"indexed": false},
    "chunk_id": {"indexed": false},
    "url": {"indexed": true},
    "heading": {"indexed": false},
    "lang": {"indexed": false, "optional": true},
  },
} as const

const R2_OBJECTS = [
    "raw_source_files: html, md, pdf (if supported later)",
    "normalized_text_files when text is too large for D1",
] as const

const DURABLE_OBJECT_STATE = {
    "summary": "rolling summary",
    "recent_turns": "last N turns",
    "project_id": "selected project",
    "preferences": "session preferences",
} as const

const WORKERS_AI = {
    "embeddings": "Workers AI embedding model for chunk and query vectors",
} as const
```

### Business Logic
The core flows are designed around Cloudflare-native services for coordination, embeddings, user input, and memory.

Ingestion and indexing (Workflow-driven)
Current scope: GitHub repo ingestion only. Other methods are stretch goals.
```ts
type IndexRequest = {
  project_id: string
  source_type: string
  source_ref: string
}

function startIndexing(request: IndexRequest): { workflow_id: string } {
  const workflow_id = triggerWorkflow("IndexProjectWorkflow", request)
  return { workflow_id }
}

function IndexProjectWorkflow(input: IndexRequest): void {
  const sources = discoverSources(input.source_type, input.source_ref)
  for (const source of sources) {
    const raw_key = r2PutRaw(source)
    const text = normalizeToText(raw_key)
    const chunks = chunkText(text, { max_chars: 4000, overlap_chars: 400 })
    for (const chunk of chunks) {
      const vector = workersAiEmbed(chunk.text)
      vectorizeUpsert(vector, { metadata: chunk.metadata })
      d1UpsertChunkMetadata(chunk)
    }
  }
  d1MarkProjectReady(input.project_id)
}
```

Chat query flow (Durable Object + Workers AI)
```ts
function handleChatMessage(
  session_id: string,
  message: string,
): void {
  const session = new ChatSessionDO(session_id)
  const query_vector = workersAiEmbed(message)
  const matches = vectorizeQuery(query_vector, {
    filters: {
      project_id: session.project_id,
    },
    top_k: 6,
  })
  const context_chunks = fetchChunks(matches)
  const response_stream = workersAiChat({
    system_prompt: SYSTEM_PROMPT,
    summary: session.summary,
    recent_turns: session.recent_turns,
    context: context_chunks,
    user_message: message,
  })
  session.stream(response_stream)
  session.persistTurns(message, response_stream.final_text)
  session.maybeUpdateSummary()
}
```

Memory and state
- Durable Objects hold per-session state and storage for summaries and recent turns, scoped to a project
- A project can contain multiple chat sessions with separate memory
- D1 chat_logs are optional for analytics/export and should include project_id

### Failure scenarios and error conditions
Ingestion and indexing
- Source fetch fails (bad URL, auth, network): mark project as failed, surface error in project creation flow
- Workflow step retry causes duplicates: use content_hash and chunk_id idempotency
- Embedding model failure or rate limiting: backoff and retry, capture partial failures
- Vectorize upsert error: retry per batch, track failed chunk_ids for re-run

Chat and retrieval
- No matching chunks: return a grounded "not found" response with guidance
- DO eviction: recover from DO storage and continue session
- Large projects: cap chunk count, paginate retrieval, or store chunk text in R2

Security and abuse
- Project creation and indexing endpoints are open; add auth later if needed
- Per-IP and per-session rate limiting at Worker or WAF
- Retrieval strictly scoped to project_id to prevent cross-project leakage

### Frontend Presentation and Layout
The UI should be minimal and clean. The color scheme should be inspired by dark-mode dev environments. The UI will consist of 2 pages, a project page and a chat page:

Project Page
- Used to create projects
- small hero section in top 3rd of the page with DocsLM title
- text bar below the hero section to enter github repo link, with a 'grep this repo' submitt button to the left
- Existing projects shown as rectangular cards below the search bar. 5 of these cards should fit across a normal 1920x1080px screen
  - Clicking on project card will bring up the chat page in that project. Deletion and rename functions should be hidden in a popup that opens when an action button on the top right of the card is clicked.
  -  Just to the left of the action button (action button should be on the top right corner of the card) should be a LED indicator of the project's status as ready/indexing/failed, which corresponds to green/orange/red. There should also be text to the right of the LED reading 'status: <STATUS>'.

Chat page
- Two-panel layout on desktop: left column for chat session switching and management, right for chat
- Note: Projects share the same datastore and allow the user to easily create multiple chat sessions for each project.
- Message list with citations and chunk source links
- Input row with text box and send button
- Streaming responses with partial tokens for perceived speed

Project creation
- Inline flow to create a new project from a GitHub repo URL
- Additional ingestion methods moved to stretch goals
- Show indexing status inside the project view

State handling
- session_id stored in localStorage
- WebSocket or SSE to stream DO responses
- Graceful offline and error messaging
