# Agent Guide

This repository is a Cloudflare Workers backend for DocsLM. It uses TypeScript, Durable Objects, Workflows, D1, R2, and Vectorize. The codebase is small and has no frontend.

## Quick Orientation
- Backend entrypoint: `workers/api/src/index.ts`
- Durable Object: `workers/durable-objects/src/ChatSessionDO.ts`
- Workflow: `workflows/src/IndexProjectWorkflow.ts`
- Shared utilities: `packages/shared/src/*`
- Wrangler config: `wrangler.jsonc`
- D1 migration: `migrations/0001_init.sql`

## Build, Lint, Test
The project uses ESLint and Wrangler. There is no test runner yet.

### Local dev (primary, remote bindings enabled)
```bash
wrangler dev --config wrangler.jsonc
```

### Full remote dev (Worker runs on Cloudflare)
```bash
wrangler dev --remote --config wrangler.jsonc
```

### Lint
```bash
npm run lint
```

### Migrations
```bash
wrangler d1 create docs_lm
wrangler d1 execute docs_lm --file migrations/0001_init.sql
```

### Running a single test
No test runner is configured. If you add tests later, document the exact command here. Until then:
- Add a section in this file with the single-test invocation once a test framework exists.

### Endpoint smoke test
```bash
bash scripts/test_backend.sh
```

## Code Style Guidelines
Follow these conventions consistently. The project deliberately avoids terse patterns.

### Language and formatting
- Use TypeScript for all backend code.
- Prefer standard function declarations over arrow functions.
- Do not use single-line `if` statements. Always use braces and multi-line blocks.
- Keep formatting consistent with ESLint-like defaults (2-space indentation, trailing commas where appropriate).
- Avoid overly compact expressions; keep logic readable and explicit.
- ESLint config is in `eslint.config.mts` and uses flat config.

### Imports
- Use relative imports for internal modules.
- Group imports by source (external first, then internal), separated by a blank line if both exist.
- Avoid unused imports and circular dependencies.
- Do not rely on path aliases unless they are defined in tooling config.

### Naming conventions
- `camelCase` for variables, functions, and object properties.
- `PascalCase` for classes and types.
- `UPPER_SNAKE_CASE` for constants that are truly constant (e.g., model IDs).
- Keep naming aligned with domain concepts: `project_id`, `doc_id`, `chunk_id`, `session_id`.

### Types and interfaces
- Define shared types in `packages/shared/src/types.ts`.
- Prefer explicit interfaces and type aliases over ad-hoc `any`.
- Use narrow types for `source_type` and other enums.
- Validate request payloads at route boundaries before passing to domain logic.
- Keep JSON parsing guarded with `unknown` and explicit shape checks.

### Error handling
- Return JSON errors with `{ "error": "message" }` and appropriate HTTP status codes.
- Use explicit `try/catch` blocks around persistence and external API calls.
- Avoid swallowing errors silently; set `projects.status` to `failed` if ingestion fails.
- For unsupported content types (e.g., PDF), return a clear stub message and skip indexing.

### Separation of concerns
- HTTP routes should parse/validate input and delegate to helpers.
- Durable Object handles session state, retrieval, and LLM calls.
- Workflow handles ingestion and indexing only.
- Shared utilities live in `packages/shared/src`.

### Data access
- Use D1 prepared statements with `bind`.
- Keep SQL statements in the module that owns the data access logic.
- Use content hashing for idempotency in ingestion workflows.

### Storage conventions
- D1 stores metadata and chunk text for retrieval.
- R2 stores raw/normalized documents (source of truth).
- Vectorize stores embeddings with metadata filters.
- Durable Object storage stores per-session memory (summary and recent turns).

### RAG behavior
- Embeddings must be generated with Workers AI.
- Retrieval must filter by `project_id`.
- Provide citations in responses (URLs and optional headings).

### API behavior
- `POST /api/projects` creates a project and triggers indexing.
- `POST /api/index/start` triggers an indexing workflow for an existing project.
- `GET /api/index/status` returns the project status.
- `POST /api/chat` forwards to the session Durable Object.

## Cloudflare Configuration
- `wrangler.jsonc` is authoritative.
- Durable Object migrations are required; do not remove the `migrations` block.
- Ensure bindings exist: `AI`, `DB`, `DOCS_BUCKET`, `VECTORIZE_INDEX`, `CHAT_SESSIONS`, `WORKFLOWS`.
- Workflows binding uses `IndexProjectWorkflow`.

## Security and Secrets
- Do not log secrets or request bodies containing credentials.
- Keep `.dev.vars` and `.env*` files out of version control.

## When Adding Tests (future)
Add a minimal test runner and document:
- Command to run all tests.
- Command to run a single test by file or name.
- Any setup required for Workers/D1 stubs.

## Files to Be Careful With
- `migrations/0001_init.sql`: schema changes should be additive and versioned.
- `wrangler.jsonc`: keep bindings aligned with code imports.
- `workers/durable-objects/src/ChatSessionDO.ts`: session memory and retrieval logic.
- `workflows/src/IndexProjectWorkflow.ts`: ingestion pipeline and idempotency logic.

## No Extra Agent Rules
No Cursor or Copilot rule files are present in this repo.
