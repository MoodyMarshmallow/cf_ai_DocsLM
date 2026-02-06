import { handleChat } from "./routes/chat"
import { handleIndexStart, handleIndexStatus } from "./routes/indexing"
import {
  handleProjectCreate,
  handleProjectDelete,
  handleProjectList,
  handleProjectUpdate,
} from "./routes/projects"
import { Env } from "../../../packages/shared/src/types"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env)
  },
}

export { ChatSessionDO } from "../../durable-objects/src/ChatSessionDO"
export { IndexProjectWorkflow } from "../../../workflows/src/IndexProjectWorkflow"

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === "/api/chat" && request.method === "POST") {
    return handleChat(request, env)
  }

  if (path === "/api/projects" && request.method === "GET") {
    return handleProjectList(request, env)
  }

  if (path === "/api/projects" && request.method === "POST") {
    return handleProjectCreate(request, env)
  }

  if (path.startsWith("/api/projects/") && request.method === "PATCH") {
    return handleProjectUpdate(request, env)
  }

  if (path.startsWith("/api/projects/") && request.method === "DELETE") {
    return handleProjectDelete(request, env)
  }

  if (path === "/api/index/start" && request.method === "POST") {
    return handleIndexStart(request, env)
  }

  if (path === "/api/index/status" && request.method === "GET") {
    return handleIndexStatus(request, env)
  }

  return jsonError("Not found", 404)
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: {
      "content-type": "application/json",
    },
  })
}
