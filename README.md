# cf_ai_DocsLM

## Backend (Cloudflare Workers)

### Prerequisites
- Node.js 18+
- Cloudflare account and `wrangler` installed

### Setup
1) Configure bindings in `wrangler.jsonc`
   - Replace `REPLACE_WITH_D1_ID`
   - Ensure the R2 bucket and Vectorize index exist

2) Create the D1 database (if not already created)
```bash
wrangler d1 create docs_lm
```

3) Apply the D1 migration
```bash
wrangler d1 execute docs_lm --file migrations/0001_init.sql
```

4) Create the R2 bucket
```bash
wrangler r2 bucket create docs-lm
```

5) Create the Vectorize index
```bash
wrangler vectorize create docs_chunks --dimensions 768 --metric cosine
```

6) Create the Workers AI binding (no extra setup needed)
   - The `AI` binding is configured in `wrangler.jsonc` and uses Cloudflare Workers AI.

### Run locally (remote bindings enabled)
```bash
wrangler dev --config wrangler.jsonc
```

### Full remote dev (Worker runs on Cloudflare)
```bash
wrangler dev --remote --config wrangler.jsonc
```

### Example requests
Create a project from a GitHub repo:
```bash
curl -X POST http://127.0.0.1:8787/api/projects \
  -H "content-type: application/json" \
  -d '{"project_id":"my-project","source_ref":"https://github.com/org/repo"}'
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
