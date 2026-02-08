export interface Project {
  project_id: string
  name: string
  source_ref: string
  status: string
  created_at: string
  updated_at: string
}

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
  citations?: Array<{ url: string; heading_path?: string }>
}

export interface ChatResponse {
  session_id: string
  message: string
  citations: Array<{ url: string; heading_path?: string }>
}

export interface ProjectStatus {
  status: string
  updated_at: string
}

export interface ChatSession {
  session_id: string
  project_id: string
  title: string
  created_at: string
  updated_at: string
  last_message_at?: string | null
}

export interface SessionMessage {
  turn_id: number
  session_id: string
  project_id: string
  role: "user" | "assistant"
  content: string
  created_at: string
}

const API_BASE = import.meta.env.VITE_API_BASE || ""

export async function listProjects(): Promise<Project[]> {
  const url = API_BASE + "/api/projects"
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    console.error("[projects] fetch failed", { apiBase: API_BASE, url: url, error: String(error) })
    throw error
  }
  if (!response.ok) {
    let bodyText = ""
    try {
      bodyText = await response.text()
    } catch (error) {
      bodyText = String(error)
    }
    console.error("[projects] fetch non-ok", {
      apiBase: API_BASE,
      url: url,
      status: response.status,
      body: bodyText,
    })
    throw new Error("Failed to load projects")
  }
  const payload = await response.json()
  const projects = payload.projects || []
  console.log("[projects] fetch ok", { count: projects.length })
  return projects
}

export async function createProject(input: {
  name: string
  source_ref: string
}): Promise<Project> {
  const response = await fetch(API_BASE + "/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  })

  if (response.status === 409) {
    const error = new Error("Project name already exists")
    ;(error as { code?: string }).code = "NAME_EXISTS"
    throw error
  }

  if (!response.ok) {
    throw new Error("Failed to create project")
  }

  const payload = await response.json()
  return {
    project_id: payload.project_id,
    name: payload.name || input.name,
    source_ref: input.source_ref,
    status: "indexing...",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

export async function updateProject(
  projectId: string,
  input: { name?: string; source_ref?: string },
): Promise<void> {
  const response = await fetch(API_BASE + "/api/projects/" + projectId, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  })

  if (response.status === 409) {
    const error = new Error("Project name already exists")
    ;(error as { code?: string }).code = "NAME_EXISTS"
    throw error
  }

  if (!response.ok) {
    throw new Error("Failed to update project")
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(API_BASE + "/api/projects/" + projectId, {
    method: "DELETE",
  })

  if (!response.ok) {
    throw new Error("Failed to delete project")
  }
}

export async function getProjectStatus(projectId: string): Promise<ProjectStatus> {
  const response = await fetch(
    API_BASE + "/api/index/status?project_id=" + encodeURIComponent(projectId),
  )
  if (!response.ok) {
    throw new Error("Failed to load project status")
  }
  return response.json()
}

export async function sendChat(
  projectId: string,
  sessionId: string,
  message: string,
): Promise<ChatResponse> {
  const response = await fetch(API_BASE + "/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      project_id: projectId,
      session_id: sessionId,
      message: message,
    }),
  })

  if (!response.ok) {
    throw new Error("Chat request failed")
  }

  return response.json()
}

export async function sendChatStream(
  projectId: string,
  sessionId: string,
  message: string,
  onToken: (text: string) => void,
): Promise<ChatResponse> {
  const response = await fetch(API_BASE + "/api/chat/stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      project_id: projectId,
      session_id: sessionId,
      message: message,
    }),
  })

  if (!response.ok) {
    const bodyText = await response.text()
    console.error("[chat] stream request failed", {
      project_id: projectId,
      session_id: sessionId,
      status: response.status,
      body: bodyText,
    })
    throw new Error("Chat stream request failed")
  }

  if (!response.body) {
    console.error("[chat] stream response missing body", {
      project_id: projectId,
      session_id: sessionId,
    })
    throw new Error("Chat stream response missing body")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let finalCitations: Array<{ url: string; heading_path?: string }> = []
  let seenDone = false

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    buffer += decoder.decode(chunk.value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() || ""

    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      let event: { type?: string; text?: string; citations?: Array<{ url: string; heading_path?: string }> }
      try {
        event = JSON.parse(line) as {
          type?: string
          text?: string
          citations?: Array<{ url: string; heading_path?: string }>
        }
      } catch (error) {
        console.error("[chat] stream parse error", { line: line, error: String(error) })
        continue
      }

      if (event.type === "token") {
        onToken(event.text || "")
      } else if (event.type === "done") {
        finalCitations = event.citations || []
        seenDone = true
      } else {
        console.warn("[chat] stream unknown event", event)
      }
    }
  }

  if (!seenDone) {
    console.warn("[chat] stream ended without done event", {
      project_id: projectId,
      session_id: sessionId,
    })
  }

  return {
    session_id: sessionId,
    message: "",
    citations: finalCitations,
  }
}

export async function listSessions(projectId: string): Promise<ChatSession[]> {
  const response = await fetch(API_BASE + "/api/projects/" + projectId + "/sessions")
  if (!response.ok) {
    throw new Error("Failed to load sessions")
  }
  const payload = await response.json()
  return payload.sessions || []
}

export async function createSession(projectId: string, title?: string): Promise<ChatSession> {
  const response = await fetch(API_BASE + "/api/projects/" + projectId + "/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: title }),
  })
  if (!response.ok) {
    throw new Error("Failed to create session")
  }
  return response.json()
}

export async function renameSession(
  projectId: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const response = await fetch(
    API_BASE + "/api/projects/" + projectId + "/sessions/" + sessionId,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: title }),
    },
  )
  if (!response.ok) {
    throw new Error("Failed to rename session")
  }
}

export async function deleteSession(projectId: string, sessionId: string): Promise<void> {
  const response = await fetch(API_BASE + "/api/projects/" + projectId + "/sessions/" + sessionId, {
    method: "DELETE",
  })
  if (!response.ok) {
    throw new Error("Failed to delete session")
  }
}

export async function listSessionMessages(
  projectId: string,
  sessionId: string,
): Promise<SessionMessage[]> {
  const response = await fetch(
    API_BASE + "/api/projects/" + projectId + "/sessions/" + sessionId + "/messages",
  )
  if (!response.ok) {
    throw new Error("Failed to load session messages")
  }
  const payload = await response.json()
  return payload.messages || []
}
