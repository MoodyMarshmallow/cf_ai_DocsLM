# DocsLM Frontend + Session Hierarchy Revision Plan

## Goals
- Align the frontend with the `PLAN.MD` "Frontend Presentation and Layout" direction.
- Introduce explicit project -> chat session -> messages hierarchy.
- Keep chat non-streaming first, then add streaming in a later phase.

## Current Gaps
- Project page is functional but does not match planned hero/search/card presentation.
- Chat page currently supports a single implicit session per project.
- Backend accepts `session_id` for chat but has no first-class session CRUD/list/history APIs.
- No project-scoped session registry for validating ownership of `session_id`.

## Delivery Phases

### Phase 1 (current): session hierarchy foundation (non-streaming)
#### Backend
1. Add D1 schema for chat sessions.
   - Create `chat_sessions` table keyed by `session_id` with `project_id`, `title`, and timestamps.
   - Add indexes for project-scoped session list queries.

2. Add session APIs.
   - `GET /api/projects/:project_id/sessions`
   - `POST /api/projects/:project_id/sessions`
   - `PATCH /api/projects/:project_id/sessions/:session_id`
   - `DELETE /api/projects/:project_id/sessions/:session_id`
   - `GET /api/projects/:project_id/sessions/:session_id/messages`

3. Update chat entrypoint to be session-aware.
   - Validate `project_id` readiness as today.
   - If `session_id` is missing, generate one.
   - Ensure generated/provided `session_id` belongs to the `project_id`.
   - Auto-create session row when needed.
   - Persist user and assistant turns to `chat_logs` for session message history reload.
   - Update `chat_sessions.updated_at` and `chat_sessions.last_message_at`.

4. Update delete flow.
   - Project delete should also remove `chat_sessions` rows for that project.

5. Add diagnostics.
   - Log session create/list/update/delete.
   - Log chat session ownership conflicts and persistence failures.

#### Frontend
1. API client support for sessions.
   - Add session CRUD/list/history methods in `apps/web/src/lib/api.ts`.

2. Session state model changes.
   - Replace "one generated session id per project" assumption with "active session id per project".
   - Keep localStorage only for active session pointer.

3. Chat page session UX foundation.
   - Add left session list panel with create/select/delete/rename.
   - Load messages from backend when switching sessions.
   - Keep existing non-streaming send flow.

### Phase 2: visual overhaul per PLAN.MD
1. Project page redesign.
   - Hero in top third.
   - Inline repo input + "grep this repo" button.
   - Dense card grid targeting 5 cards per 1920px row.
   - Card status LED + status label.
   - Top-right actions popup for rename/delete.

2. Chat page polish.
   - Refine two-panel layout, spacing, typography, and status presentation.
   - Improve citations and source link presentation.

3. Responsive behavior.
   - Mobile-first fallback for session list and chat composer.

### Phase 3: streaming and resilience
1. Add streaming transport for chat responses.
2. Incremental token rendering in UI.
3. Graceful fallback for stream interruptions and offline states.

## API Shape Draft (Phase 1)

### Session object
```json
{
  "session_id": "uuid",
  "project_id": "ulid",
  "title": "New chat",
  "created_at": "2026-02-06T12:00:00.000Z",
  "updated_at": "2026-02-06T12:05:00.000Z",
  "last_message_at": "2026-02-06T12:05:00.000Z"
}
```

### Message object
```json
{
  "turn_id": 123,
  "session_id": "uuid",
  "project_id": "ulid",
  "role": "user",
  "content": "How do I run this repo?",
  "created_at": "2026-02-06T12:05:00.000Z"
}
```

## Risks and Mitigations
- Session ID collisions across projects: enforce session ownership checks before chat dispatch.
- Backward compatibility: preserve existing `/api/chat` request shape with optional `session_id`.
- Data growth in `chat_logs`: keep message payload simple in Phase 1 and add pruning strategy later.

## Verification Plan
- Create project -> create two sessions -> send separate chats -> verify histories stay isolated.
- Switch sessions in UI and confirm message list reloads from backend.
- Delete session and verify related `chat_logs` rows are removed.
- Delete project and verify `projects`, `chat_sessions`, and `chat_logs` rows are removed.
