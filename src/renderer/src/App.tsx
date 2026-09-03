import { FormEvent, useCallback, useEffect, useState } from "react";
import type { AgentEventEnvelope } from "../../shared/agent-events";
import type { BrainstormResult, ClaudeDemoResult, TaskSummary } from "../../shared/app";
import type { Project, ProjectDraft } from "../../shared/projects";

const emptyDraft: ProjectDraft = {
  name: "",
  path: "",
  provider: "claude",
  workflow: "superpowers",
};

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Something went wrong.";
  const match = error.message.match(/\{.*\}/s);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { message?: string };
      if (parsed.message) return parsed.message;
    } catch {
      // Fall back to the safe Electron error message.
    }
  }
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function projectApi(): Window["anubis"]["projects"] {
  const api = window.anubis?.projects;
  if (!api) {
    throw new Error("Desktop bridge unavailable. Open Anubis through Electron with npm run dev or npm run preview.");
  }
  return api;
}

function appApi(): Window["anubis"]["app"] {
  const api = window.anubis?.app;
  if (!api) {
    throw new Error("Desktop bridge unavailable. Open Anubis through Electron with npm run dev or npm run preview.");
  }
  return api;
}

function eventDetail(event: AgentEventEnvelope): string {
  switch (event.payload.type) {
    case "message_completed":
      return event.payload.text ?? "";
    case "completed":
      return event.payload.summary ?? "";
    case "session_finished":
      return event.payload.outcome;
    case "stage_changed":
      return event.payload.stage;
    case "thinking_status":
      return event.payload.text ?? "";
    case "failed":
      return event.payload.error.message;
    case "tool_started":
    case "tool_finished":
    case "tool_failed":
      return event.payload.tool;
    default:
      return "";
  }
}

function eventBody(event: AgentEventEnvelope): string {
  const detail = eventDetail(event);
  return detail || JSON.stringify(event.payload, null, 2);
}

function eventTime(event: AgentEventEnvelope): string {
  return new Date(event.occurredAt).toLocaleTimeString();
}

function readableEvents(events: AgentEventEnvelope[]): AgentEventEnvelope[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const body = eventBody(event).trim();
    if (!body) return false;
    if (seen.has(body)) return false;
    seen.add(body);
    return true;
  });
}

function Logo(): React.JSX.Element {
  return (
    <div className="logo" aria-label="Anubis">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M14 9 7 3l2 16 7 8-2-18Zm20 0 7-6-2 16-7 8 2-18Z" />
        <path d="M15 14h18l5 10-3 18-11 4-11-4-3-18 5-10Z" />
        <path className="logo-eye" d="m15 27 7 2-6 3-1-5Zm18 0-7 2 6 3 1-5Z" />
      </svg>
      <span>ANUBIS</span>
    </div>
  );
}

interface EventViewerProps {
  title: string;
  events: AgentEventEnvelope[];
  onClose(): void;
}

function EventViewer({ title, events, onClose }: EventViewerProps): React.JSX.Element {
  const richEvents = readableEvents(events);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog event-dialog" role="dialog" aria-modal="true" aria-labelledby="event-dialog-title">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">SESSION EVENTS</p>
            <h2 id="event-dialog-title">{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">X</button>
        </header>
        <div className="event-dialog-body">
          <div className="event-summary">
            <strong>{events.length} events persisted</strong>
            <span>{richEvents.length} with readable output</span>
          </div>
          {richEvents.length > 0 && (
            <section className="response-panel" aria-label="Readable responses">
              <h3>Responses</h3>
              {richEvents.map((event) => (
                <article key={event.eventId}>
                  <span>#{event.sequence} {event.payload.type} - {eventTime(event)}</span>
                  <pre>{eventBody(event)}</pre>
                </article>
              ))}
            </section>
          )}
          <section className="event-details-list" aria-label="All session events">
            <h3>All Events</h3>
            {events.map((event) => (
              <details
                className="event-details"
                key={event.eventId}
                open={event.payload.type === "message_completed" || event.payload.type === "completed" || event.payload.type === "failed"}
              >
                <summary>
                  <span className="event-sequence">#{event.sequence}</span>
                  <span className="event-type">{event.payload.type}</span>
                  <time>{eventTime(event)}</time>
                </summary>
                <pre>{eventBody(event)}</pre>
                <pre className="payload-json">{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            ))}
          </section>
        </div>
      </section>
    </div>
  );
}

interface ProjectFormProps {
  project: Project | null;
  onClose(): void;
  onSaved(): Promise<void>;
}

function ProjectForm({ project, onClose, onSaved }: ProjectFormProps): React.JSX.Element {
  const [draft, setDraft] = useState<ProjectDraft>(() =>
    project
      ? {
          name: project.name,
          path: project.path,
          provider: project.provider,
          workflow: project.workflow,
        }
      : emptyDraft,
  );
  const [pathMessage, setPathMessage] = useState("");
  const [pathValid, setPathValid] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function chooseDirectory(): Promise<void> {
    try {
      const path = await projectApi().selectDirectory();
      if (path) {
        setDraft((current) => ({ ...current, path }));
        setPathMessage("");
        setPathValid(false);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function validateDirectory(): Promise<boolean> {
    if (!draft.path.trim()) {
      setPathMessage("Choose a local project folder.");
      setPathValid(false);
      return false;
    }
    const result = await projectApi().validatePath(draft.path);
    setPathValid(result.valid);
    setPathMessage(result.valid ? "Directory is ready" : (result.message ?? "Invalid directory"));
    if (result.valid && result.canonicalPath) {
      setDraft((current) => ({ ...current, path: result.canonicalPath! }));
    }
    return result.valid;
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      if (!(await validateDirectory())) return;
      if (project) {
        await projectApi().update({ ...draft, id: project.id, enabled: project.enabled });
      } else {
        await projectApi().create(draft);
      }
      await onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">LOCAL WORKSPACE</p>
            <h2 id="project-dialog-title">{project ? "Edit project" : "Connect a project"}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">X</button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Project name
            <input
              autoFocus
              value={draft.name}
              maxLength={120}
              placeholder="Trading Engine"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              required
            />
          </label>
          <label>
            Project directory
            <div className="path-field">
              <input
                value={draft.path}
                placeholder="C:\\Projects\\trading-engine"
                onChange={(event) => {
                  setDraft({ ...draft, path: event.target.value });
                  setPathMessage("");
                  setPathValid(false);
                }}
                required
              />
              <button type="button" className="browse-button" onClick={() => void chooseDirectory()}>Browse</button>
            </div>
          </label>
          {pathMessage && <p className={pathValid ? "field-success" : "field-error"}>{pathValid ? "OK " : ""}{pathMessage}</p>}
          <div className="form-grid">
            <label>
              Provider
              <select value={draft.provider} disabled>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label>
              Workflow
              <select value={draft.workflow} disabled>
                <option value="superpowers">Superpowers</option>
              </select>
            </label>
          </div>
          <p className="form-hint">Provider and workflow are fixed for the first release. Your source stays on this machine.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <footer className="dialog-actions">
            <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
            <button className="button primary" disabled={saving}>{saving ? "Saving..." : project ? "Save changes" : "Add project"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

interface TaskFormProps {
  project: Project;
  onClose(): void;
  onStarted(result: BrainstormResult): Promise<void>;
}

function TaskForm({ project, onClose, onStarted }: TaskFormProps): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const result = await appApi().startBrainstorm({ projectId: project.id, title, description });
      await onStarted(result);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}
    >
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">LOCAL TASK</p>
            <h2 id="task-dialog-title">New task</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close" disabled={saving}>X</button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Project
            <input value={project.name} disabled />
          </label>
          <label>
            Task title
            <input
              autoFocus
              value={title}
              maxLength={160}
              placeholder="Investigate flaky order sync"
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </label>
          <label>
            Description
            <textarea
              value={description}
              maxLength={4000}
              placeholder="Describe the behavior, files involved, expected outcome, or constraints."
              onChange={(event) => setDescription(event.target.value)}
              required
            />
          </label>
          <p className="form-hint">Anubis will start a Claude brainstorm session in this repository and persist the event history.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <footer className="dialog-actions">
            <button type="button" className="button secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="button primary" disabled={saving}>{saving ? "Starting..." : "Start brainstorm"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formProject, setFormProject] = useState<Project | "new" | null>(null);
  const [taskProject, setTaskProject] = useState<Project | null>(null);
  const [testingProjectId, setTestingProjectId] = useState<string | null>(null);
  const [demoResult, setDemoResult] = useState<ClaudeDemoResult | null>(null);
  const [brainstormResult, setBrainstormResult] = useState<BrainstormResult | null>(null);
  const [sessionEvents, setSessionEvents] = useState<AgentEventEnvelope[]>([]);
  const [eventPanelTitle, setEventPanelTitle] = useState("Last Claude test");
  const [eventViewerOpen, setEventViewerOpen] = useState(false);
  const [tasksByProject, setTasksByProject] = useState<Record<string, TaskSummary[]>>({});

  const loadProjects = useCallback(async () => {
    try {
      setError("");
      const loadedProjects = await projectApi().list();
      setProjects(loadedProjects);
      const active = loadedProjects.filter((project) => project.enabled);
      const taskEntries = await Promise.all(
        active.map(async (project) => [project.id, await appApi().listTasks(project.id)] as const),
      );
      setTasksByProject(Object.fromEntries(taskEntries));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void loadProjects(), [loadProjects]);

  async function archive(project: Project): Promise<void> {
    if (!window.confirm(`Archive ${project.name}? You can keep its local files.`)) return;
    try {
      await projectApi().archive(project.id);
      await loadProjects();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function testClaude(project: Project): Promise<void> {
    setTestingProjectId(project.id);
    setError("");
    setDemoResult(null);
    setBrainstormResult(null);
    setSessionEvents([]);
    try {
      const result = await appApi().runClaudeDemo(project.id);
      setDemoResult(result);
      setEventPanelTitle("Last Claude test");
      setSessionEvents(await appApi().listSessionEvents(result.sessionId));
      setEventViewerOpen(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setTestingProjectId(null);
    }
  }

  async function handleBrainstormStarted(result: BrainstormResult): Promise<void> {
    setDemoResult(null);
    setBrainstormResult(result);
    setEventPanelTitle("Last brainstorm");
    setSessionEvents(await appApi().listSessionEvents(result.sessionId));
    setEventViewerOpen(true);
    await loadProjects();
  }

  async function viewTaskEvents(task: TaskSummary): Promise<void> {
    if (!task.latestSessionId) return;
    setError("");
    setDemoResult(null);
    setBrainstormResult(null);
    try {
      setEventPanelTitle(`Task #${task.taskNumber}: ${task.title}`);
      setSessionEvents(await appApi().listSessionEvents(task.latestSessionId));
      setEventViewerOpen(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const activeProjects = projects.filter((project) => project.enabled);
  const archivedProjects = projects.filter((project) => !project.enabled);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <nav aria-label="Main navigation">
          <button className="nav-item active"><span className="nav-icon">&lt;&gt;</span>Projects</button>
          <button className="nav-item" disabled><span className="nav-icon">!</span>Attention<span className="soon">Soon</span></button>
          <button className="nav-item" disabled><span className="nav-icon">=</span>History<span className="soon">Soon</span></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-badge"><span className="status-dot" />Local only</div>
          <p>Phase 1 - Projects</p>
        </div>
      </aside>

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">WORKSPACES</p>
            <h1>Projects</h1>
            <p className="subtitle">Connect local repositories and prepare them for orchestrated work.</p>
          </div>
          <button className="button primary" onClick={() => setFormProject("new")}><span>+</span>Add project</button>
        </header>

        {error && <div className="error-banner page-error" role="alert">{error}<button onClick={() => void loadProjects()}>Try again</button></div>}
        {demoResult && (
          <div className="success-banner" role="status">
            Claude SDK test saved {demoResult.eventCount} events. Session {demoResult.providerSessionId}.
          </div>
        )}
        {brainstormResult && (
          <div className="success-banner" role="status">
            Brainstorm saved {brainstormResult.eventCount} events. Session {brainstormResult.providerSessionId}.
          </div>
        )}
        {loading ? (
          <section className="loading-state"><div className="spinner" />Loading projects...</section>
        ) : activeProjects.length === 0 ? (
          <section className="empty-state">
            <div className="empty-mark"><span>&lt;&gt;</span></div>
            <p className="eyebrow">NO PROJECTS YET</p>
            <h2>Bring your first codebase</h2>
            <p>Anubis works directly inside a local folder. Add a project to begin; nothing leaves your machine.</p>
            <button className="button primary" onClick={() => setFormProject("new")}>Choose a project folder</button>
            <div className="empty-features">
              <span>OK Existing folder</span><span>OK Windows paths</span><span>OK Local SQLite</span>
            </div>
          </section>
        ) : (
          <section className="project-section">
            <div className="section-heading">
              <h2>Active projects</h2>
              <span>{activeProjects.length} {activeProjects.length === 1 ? "workspace" : "workspaces"}</span>
            </div>
            <div className="project-grid">
              {activeProjects.map((project) => (
                <article className="project-card" key={project.id}>
                  <div className="project-card-top">
                    <div className="project-symbol">{project.name.slice(0, 2).toUpperCase()}</div>
                    <div className="project-state"><span className="status-dot" />Idle</div>
                  </div>
                  <h3>{project.name}</h3>
                  <p className="project-path" title={project.path}>{project.path}</p>
                  <div className="tags"><span>Claude</span><span>Superpowers</span></div>
                  <div className="task-list">
                    {(tasksByProject[project.id] ?? []).length === 0 ? (
                      <p>No tasks yet</p>
                    ) : (
                      (tasksByProject[project.id] ?? []).slice(0, 3).map((task) => (
                        <div className="task-row" key={task.id}>
                          <div>
                            <strong>#{task.taskNumber} {task.title}</strong>
                            <span>{task.status} - {task.eventCount} events</span>
                          </div>
                          <button
                            className="text-button"
                            disabled={!task.latestSessionId || task.eventCount === 0}
                            onClick={() => void viewTaskEvents(task)}
                          >
                            View Events
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  <footer>
                    <span>Ready for tasks</span>
                    <div className="project-actions">
                      <button
                        className="text-button"
                        onClick={() => setTaskProject(project)}
                      >
                        New Task
                      </button>
                      <button
                        className="text-button"
                        disabled={testingProjectId === project.id}
                        onClick={() => void testClaude(project)}
                      >
                        {testingProjectId === project.id ? "Testing..." : "Test Claude"}
                      </button>
                      <button className="text-button" onClick={() => setFormProject(project)}>Edit</button>
                      <button className="text-button danger" onClick={() => void archive(project)}>Archive</button>
                    </div>
                  </footer>
                </article>
              ))}
            </div>
          </section>
        )}

        {archivedProjects.length > 0 && (
          <details className="archived-section">
            <summary>Archived projects <span>{archivedProjects.length}</span></summary>
            {archivedProjects.map((project) => <p key={project.id}>{project.name}<small>{project.path}</small></p>)}
          </details>
        )}
      </main>

      {formProject && (
        <ProjectForm
          project={formProject === "new" ? null : formProject}
          onClose={() => setFormProject(null)}
          onSaved={loadProjects}
        />
      )}
      {taskProject && (
        <TaskForm
          project={taskProject}
          onClose={() => setTaskProject(null)}
          onStarted={async (result) => {
            await handleBrainstormStarted(result);
          }}
        />
      )}
      {eventViewerOpen && sessionEvents.length > 0 && (
        <EventViewer title={eventPanelTitle} events={sessionEvents} onClose={() => setEventViewerOpen(false)} />
      )}
    </div>
  );
}
