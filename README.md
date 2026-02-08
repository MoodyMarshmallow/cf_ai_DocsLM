# cf_ai_DocsLM

## Backend (Cloudflare Workers)

### Prerequisites
- Node.js 18+
- Cloudflare account and `wrangler` installed

### Setup
1) Configure bindings in `wrangler.jsonc`
   - Replace `REPLACE_WITH_D1_ID`
   - Ensure the R2 bucket and Vectorize index exist

2) Create the D1 database (if not already created). Make sure you say yes to using the remote server.
```bash
npx wrangler d1 create docs_lm
```

3) Apply the D1 migration
```bash
npx wrangler d1 execute docs_lm --file migrations/0001_init.sql --remote
npx wrangler d1 execute docs_lm --file migrations/0002_chat_sessions.sql --remote
```

4) Create the R2 bucket Make sure you say yes to using the remote server.
```bash
npx wrangler r2 bucket create docs-lm
```

5) Create the Vectorize index
```bash
npx wrangler vectorize create docs_chunks --dimensions 1024 --metric cosine
```

6) Create the Vectorize metadata index for project filtering
```bash
npx wrangler vectorize create-metadata-index docs_chunks --property-name=project_id --type=string
```

7) Workers AI uses the `AI` binding configured in `wrangler.jsonc`

### Run locally (remote bindings enabled)
```bash
npx wrangler dev --config wrangler.jsonc
```

### Full remote dev (Worker runs on Cloudflare)
```bash
npx wrangler dev --remote --config wrangler.jsonc
```

## Frontend (Vite + React)

### Run locally
```bash
cd apps/web
npm install
npm run dev
```

Optional API base override:
```bash
VITE_API_BASE=http://127.0.0.1:8787 npm run dev
```

### Example requests
Create a project from a GitHub repo:
```bash
curl -X POST http://127.0.0.1:8787/api/projects \
  -H "content-type: application/json" \
  -d '{"name":"My Project","source_ref":"https://github.com/org/repo"}'
```
Note: project names must be alphanumeric with spaces or dashes.
The response includes a generated `project_id` (ULID).

List projects:
```bash
curl http://127.0.0.1:8787/api/projects
```

Check indexing status:
```bash
curl "http://127.0.0.1:8787/api/index/status?project_id=my-project"
```

Chat:
```bash
curl -X POST http://127.0.0.1:8787/api/chat \
  -H "content-type: application/json" \
  -d '{"project_id":"my-project","message":"How do I install it?"}'
```

List chat sessions for a project:
```bash
curl http://127.0.0.1:8787/api/projects/my-project/sessions
```
