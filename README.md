# DocsLM

DocsLM turns a public GitHub repository into a project-scoped chat experience.

It indexes repo files, stores chunk metadata in D1, raw content in R2, vectors in Vectorize, and serves chat through a Durable Object with retrieval scoped by `project_id`.

## What It Does Today

- Create, list, rename, and delete projects.
- Index public GitHub repositories (README/docs/code text files).
- Chunk content, embed with Workers AI, and upsert vectors to Vectorize.
- Chat with citations against indexed project content.
- Manage multiple chat sessions per project.
- Stream chat responses to the frontend.

## Architecture

- Worker API: `workers/api/src/index.ts`
- Durable Object chat runtime: `workers/durable-objects/src/ChatSessionDO.ts`
- Indexing workflow: `workflows/src/IndexProjectWorkflow.ts`
- Shared types/utilities: `packages/shared/src/*`

## Run Locally

### Prerequisites

- Node.js 18+
- Cloudflare account
- `wrangler` CLI

### 1) Install dependencies

```bash
npm install
cd apps/web && npm install
```

### 2) Create Cloudflare resources
First create the d1 database. When you run this, take note of the new `database_id` and replace the old one in `wrangler.jsonc` in `d1_databases`. Don't let wrangler write anything to `wrangler.jsonc` for you, it's already written.

```bash
npx wrangler d1 create docs_lm
```


Then run these. Once again, don't let wrangler write anything to `wrangler.jsonc`.

```bash
npx wrangler r2 bucket create docs-lm
npx wrangler vectorize create docs_chunks --dimensions 1024 --metric cosine
npx wrangler vectorize create-metadata-index docs_chunks --property-name=project_id --type=string
```

### 3) Apply migrations

```bash
npx wrangler d1 execute docs_lm --file migrations/0001_init.sql --remote
```

### 4) Start backend

```bash
npx wrangler dev --config wrangler.jsonc
```

### 5) Start frontend

```bash
cd apps/web
npm run dev
```

The Vite config proxies `/api` to `http://127.0.0.1:8787` by default.

## Helpful Commands

- Lint repo:

```bash
npm run lint
```

- Backend smoke test script:

```bash
bash scripts/test_backend.sh
```

## TODO

- Alternative ingestion methods (sitemap crawling, direct file uploads, PDF ingestion).
- Mind map and quiz generation features.
- Advanced RAG improvements (rerankers, fusion retrieval, SELF-RAG-style patterns).
- Full auth/rate-limit hardening for multi-user production use.
- Automated test suite (lint exists; no dedicated test runner configured yet).
