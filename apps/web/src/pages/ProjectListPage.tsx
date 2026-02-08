import { useEffect, useState } from "react"
import { createProject, deleteProject, getProjectStatus, listProjects, updateProject } from "../lib/api"
import type { Project } from "../lib/api"
import { useNavigate } from "react-router-dom"

function ProjectListPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sourceRef, setSourceRef] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null)
  const [typedTitle, setTypedTitle] = useState("")
  const [titleDone, setTitleDone] = useState(false)
  const [showCursor, setShowCursor] = useState(true)
  const [typingStarted, setTypingStarted] = useState(false)
  const navigate = useNavigate()

  useEffect(function () {
    const fullTitle = "DocsLM"
    let index = 0
    let interval: number | null = null
    const startDelay = window.setTimeout(function () {
      setTypingStarted(true)
      interval = window.setInterval(function () {
        index += 1
        setTypedTitle(fullTitle.slice(0, index))
        if (index >= fullTitle.length) {
          if (interval !== null) {
            window.clearInterval(interval)
          }
          setTitleDone(true)
          window.setTimeout(function () {
            setShowCursor(false)
          }, 2800)
        }
      }, 120)
    }, 800)

    return function () {
      window.clearTimeout(startDelay)
      if (interval !== null) {
        window.clearInterval(interval)
      }
    }
  }, [])

  useEffect(function () {
    void loadProjects(true)
  }, [])

  useEffect(
    function () {
      const indexingProjects = projects.filter(function (project) {
        return project.status === "indexing"
      })

      if (indexingProjects.length === 0) {
        return
      }

      let cancelled = false
      async function pollIndexingStatuses(): Promise<void> {
        const updates = await Promise.all(
          indexingProjects.map(async function (project) {
            try {
              const status = await getProjectStatus(project.project_id)
              return { project_id: project.project_id, status: status.status }
            } catch (error) {
              console.warn("[projects] status poll failed", {
                project_id: project.project_id,
                error: String(error),
              })
              return null
            }
          }),
        )

        if (cancelled) {
          return
        }

        const map = new Map<string, string>()
        for (const item of updates) {
          if (item) {
            map.set(item.project_id, item.status)
          }
        }
        if (map.size === 0) {
          return
        }

        const hasChanges = indexingProjects.some(function (project) {
          const nextStatus = map.get(project.project_id)
          return Boolean(nextStatus && nextStatus !== project.status)
        })
        if (!hasChanges) {
          return
        }

        setProjects(function (prev) {
          return prev.map(function (project) {
            const nextStatus = map.get(project.project_id)
            if (!nextStatus || nextStatus === project.status) {
              return project
            }
            return { ...project, status: nextStatus }
          })
        })
      }

      void pollIndexingStatuses()
      const interval = window.setInterval(function () {
        void pollIndexingStatuses()
      }, 3000)

      return function () {
        cancelled = true
        window.clearInterval(interval)
      }
    },
    [projects],
  )

  async function loadProjects(showLoading: boolean): Promise<void> {
    try {
      if (showLoading) {
        setLoading(true)
      }
      const data = await listProjects()
      setProjects(data)
      setError(null)
    } catch (err) {
      setError("Failed to load projects")
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setFormError(null)

    try {
      const trimmedSourceRef = sourceRef.trim()
      const derivedName = deriveProjectName(trimmedSourceRef)
      await createProject({ name: derivedName, source_ref: trimmedSourceRef })
      await loadProjects(false)
      setSourceRef("")
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "NAME_EXISTS") {
        setFormError("Project name already exists. Try a different repository name.")
      } else {
        setFormError("Failed to create project")
      }
    }
  }

  async function handleRename(project: Project): Promise<void> {
    setFormError(null)
    const nextName = window.prompt("Rename project", project.name)
    if (!nextName || !nextName.trim()) {
      setOpenMenuId(null)
      return
    }

    try {
      setBusyProjectId(project.project_id)
      await updateProject(project.project_id, {
        name: nextName.trim(),
      })
      await loadProjects(false)
      setOpenMenuId(null)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "NAME_EXISTS") {
        setFormError("Project name already exists")
      } else {
        setFormError("Failed to rename project")
      }
    } finally {
      setBusyProjectId(null)
    }
  }

  async function handleDelete(projectId: string): Promise<void> {
    const confirmed = window.confirm("Delete this project and all associated data?")
    if (!confirmed) {
      return
    }
    try {
      setBusyProjectId(projectId)
      setProjects(function (prev) {
        return prev.map(function (project) {
          if (project.project_id === projectId) {
            return { ...project, status: "deleting..." }
          }
          return project
        })
      })
      await deleteProject(projectId)
      await loadProjects(false)
      setOpenMenuId(null)
    } catch (err) {
      setFormError("Failed to delete project")
    } finally {
      setBusyProjectId(null)
    }
  }

  function openProject(project: Project): void {
    if (project.status !== "ready") {
      if (project.status === "indexing") {
        window.alert("This project is still indexing. Please wait until indexing is complete.")
        return
      }

      if (project.status === "failed") {
        window.alert("This project failed indexing. Please update the source and reindex.")
        return
      }

      if (project.status === "deleting") {
        window.alert("This project is being deleted.")
        return
      }

      window.alert("This project is not ready yet.")
      return
    }

    navigate("/project/" + project.project_id)
  }

  return (
    <div className="page projects-page">
      <header className="projects-hero">
        <h1 className="typed-title">
          <span className="typed-text">{typedTitle}</span>
          {showCursor ? (
            <span
              aria-hidden="true"
              className={typingStarted && !titleDone ? "typing-cursor steady" : "typing-cursor"}
            >
              |
            </span>
          ) : null}
        </h1>
      </header>

      <section className="project-create-bar panel">
        <form className="project-create-inline" onSubmit={handleCreate}>
          <label className="project-url-label">
            <span className="sr-only">GitHub repo URL</span>
            <input
              value={sourceRef}
              onChange={function (event) {
                setSourceRef(event.target.value)
              }}
              placeholder="https://github.com/org/repo"
              required
            />
          </label>
          <button type="submit" disabled={!sourceRef.trim()}>
            Grep This Repo
          </button>
          {formError ? <p className="error">{formError}</p> : null}
        </form>
      </section>

      <section className="panel projects-pane">
        <div className="panel-header">
          <h2>Projects</h2>
          {loading ? <span className="muted">Loading...</span> : <span className="muted">{projects.length} tracked</span>}
        </div>
        {error ? <p className="error">{error}</p> : null}

        <ul className="project-grid">
          {projects.map(function (project) {
            const isMenuOpen = openMenuId === project.project_id
            const isBusy = busyProjectId === project.project_id
            return (
              <li
                key={project.project_id}
                className="project-card"
                onClick={function () {
                  openProject(project)
                }}
                onKeyDown={function (event) {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    openProject(project)
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="project-card-top">
                  <div className="project-status-inline">
                    <span className={`status-led status-led-${project.status}`} />
                    <span className="muted">status: {project.status}</span>
                  </div>
                  <div className="project-menu-wrap">
                    <button
                      className="menu-trigger"
                      onClick={function (event) {
                        event.stopPropagation()
                        if (isMenuOpen) {
                          setOpenMenuId(null)
                        } else {
                          setOpenMenuId(project.project_id)
                        }
                      }}
                      disabled={isBusy}
                    >
                      ⋮
                    </button>
                    {isMenuOpen ? (
                      <div className="project-menu">
                        <button
                          className="secondary"
                          onClick={function (event) {
                            event.stopPropagation()
                            void handleRename(project)
                          }}
                          disabled={isBusy}
                        >
                          Rename
                        </button>
                        <button
                          className="danger"
                          onClick={function (event) {
                            event.stopPropagation()
                            void handleDelete(project.project_id)
                          }}
                          disabled={isBusy}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
                <h3>{project.name}</h3>
                <p className="muted project-source">{project.source_ref}</p>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

function deriveProjectName(sourceRef: string): string {
  const trimmed = sourceRef.trim().replace(/\/$/, "")
  if (!trimmed) {
    return "Untitled Repo"
  }
  const parts = trimmed.split("/")
  const last = parts[parts.length - 1] || "repo"
  const cleaned = last.replace(/[^A-Za-z0-9 -]/g, " ").trim()
  if (!cleaned) {
    return "Untitled Repo"
  }
  return cleaned.slice(0, 60)
}

export default ProjectListPage
