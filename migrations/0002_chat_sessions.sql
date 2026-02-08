CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_updated
  ON chat_sessions (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_session
  ON chat_sessions (project_id, session_id);
