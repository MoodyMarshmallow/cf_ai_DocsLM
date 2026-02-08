const ACTIVE_SESSION_KEY_PREFIX = "docs-lm-active-session-"

export function getActiveSessionId(projectId: string): string | null {
  const key = ACTIVE_SESSION_KEY_PREFIX + projectId
  return localStorage.getItem(key)
}

export function setActiveSessionId(projectId: string, sessionId: string): void {
  const key = ACTIVE_SESSION_KEY_PREFIX + projectId
  localStorage.setItem(key, sessionId)
}

export function clearActiveSessionId(projectId: string): void {
  const key = ACTIVE_SESSION_KEY_PREFIX + projectId
  localStorage.removeItem(key)
}
