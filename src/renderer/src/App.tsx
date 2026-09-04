import { FormEvent, useCallback, useEffect, useState } from "react";
import type { AgentEventEnvelope } from "../../shared/agent-events";
import type {
  BrainstormResult,
  DesktopNotificationTestKind,
  ExecutionResult,
  NotificationSettings,
  ProjectStats,
  TaskSpec,
  TaskSummary,
} from "../../shared/app";
import type { Project, ProjectDraft } from "../../shared/projects";
import type { TaskStatus } from "../../shared/tasks";

const emptyDraft: ProjectDraft = {
  name: "",
  path: "",
  provider: "claude",
  workflow: "superpowers",
};

type AppView = "projects" | "attention" | "board" | "history" | "settings";

interface ReviewTask {
  project: Project;
  task: TaskSummary;
}

interface BoardColumn {
  id: string;
  title: string;
  statuses: TaskStatus[];
}

const boardColumns: BoardColumn[] = [
  { id: "draft", title: "Draft", statuses: ["DRAFT", "BRAINSTORMING"] },
  { id: "review", title: "Review", statuses: ["WAITING_USER", "DESIGN_REVIEW"] },
  { id: "queued", title: "Queued", statuses: ["QUEUED", "READY_TO_RESUME"] },
  { id: "running", title: "Running", statuses: ["PLANNING", "EXECUTING", "VERIFYING"] },
  { id: "done", title: "Done", statuses: ["DONE"] },
  { id: "blocked", title: "Blocked", statuses: ["BLOCKED", "FAILED", "INTERRUPTED", "CANCELLED"] },
];

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

function activityTime(value: string): string {
  return new Date(value).toLocaleTimeString();
}

function activityDateTime(value: string): string {
  return new Date(value).toLocaleString();
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

function taskActivityLabel(task: TaskSummary): string {
  if (task.pendingQuestions.length > 0) return `Question: ${task.pendingQuestions[0]?.prompt ?? ""}`;
  if (task.latestEventText) return `${task.latestEventType ?? "event"}: ${task.latestEventText}`;
  return task.latestEventType ?? "No event yet";
}

function viewEyebrow(view: AppView): string {
  if (view === "attention") return "REVIEW QUEUE";
  if (view === "board") return "TASK BOARD";
  if (view === "history") return "TASK HISTORY";
  if (view === "settings") return "PREFERENCES";
  return "WORKSPACES";
}

function viewTitle(view: AppView): string {
  if (view === "attention") return "Attention";
  if (view === "board") return "Board";
  if (view === "history") return "History";
  if (view === "settings") return "Settings";
  return "Projects";
}

function viewSubtitle(view: AppView): string {
  if (view === "attention") return "Answer brainstorm questions and review specs before moving tasks forward.";
  if (view === "board") return "Track local tasks across brainstorm, review, queue, execution, and completion.";
  if (view === "history") return "Review completed, failed, interrupted, and cancelled task runs.";
  if (view === "settings") return "Control which local desktop notifications Anubis sends.";
  return "Connect local repositories and prepare them for orchestrated work.";
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
  spec?: TaskSpec;
  reviewTask?: TaskSummary;
  onClose(): void;
  onApprove?(task: TaskSummary): Promise<void>;
  onRequestChanges?(task: TaskSummary, feedback: string): Promise<void>;
  onAnswerQuestion?(task: TaskSummary, questionId: string, answer: string): Promise<void>;
}

function EventViewer({
  title,
  events,
  spec,
  reviewTask,
  onClose,
  onApprove,
  onRequestChanges,
  onAnswerQuestion,
}: EventViewerProps): React.JSX.Element {
  const richEvents = readableEvents(events);
  const isReviewFlow = Boolean(reviewTask);
  const [reviewing, setReviewing] = useState<"approve" | "changes" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const claudeWaitLabel =
    reviewing === "changes"
      ? reviewTask?.status === "WAITING_USER"
        ? "Sending answer to Claude..."
        : "Asking Claude to revise the spec..."
      : "";

  async function approve(): Promise<void> {
    if (!reviewTask) return;
    setReviewing("approve");
    try {
      await onApprove?.(reviewTask);
      onClose();
    } finally {
      setReviewing(null);
    }
  }

  async function requestChanges(): Promise<void> {
    if (!reviewTask || !feedback.trim()) return;
    setReviewing("changes");
    try {
      await onRequestChanges?.(reviewTask, feedback);
      setFeedback("");
    } finally {
      setReviewing(null);
    }
  }

  async function answerQuestion(questionId: string, answer: string): Promise<void> {
    if (!reviewTask || !answer.trim()) return;
    setReviewing("changes");
    try {
      await onAnswerQuestion?.(reviewTask, questionId, answer);
      setAnswers({});
    } finally {
      setReviewing(null);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog event-dialog" role="dialog" aria-modal="true" aria-labelledby="event-dialog-title">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">{isReviewFlow ? "TASK REVIEW" : "SESSION EVENTS"}</p>
            <h2 id="event-dialog-title">{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">X</button>
        </header>
        {claudeWaitLabel && (
          <div className="claude-wait" role="status">
            <span className="spinner" />
            <div>
              <strong>{claudeWaitLabel}</strong>
              <p>This can take a little while. The response will appear here when the iteration finishes.</p>
            </div>
          </div>
        )}
        <div className="event-dialog-body">
          <div className="event-summary">
            <strong>{reviewTask?.status ?? "SESSION"}</strong>
            <span>{events.length} events persisted</span>
            {spec && <span>Spec v{spec.version}</span>}
          </div>
          {spec && (
            <section className="response-panel" aria-label="Current spec">
              <h3>Stored Spec</h3>
              <article>
                <span>v{spec.version} - {spec.sha256.slice(0, 12)}</span>
                <pre>{spec.contentMarkdown}</pre>
              </article>
            </section>
          )}
          {reviewTask?.status === "WAITING_USER" && reviewTask.pendingQuestions.length > 0 && (
            <section className="question-panel" aria-label="Pending questions">
              <h3>Questions</h3>
              {reviewTask.pendingQuestions.map((question) => (
                <article key={question.id}>
                  <strong>{question.prompt}</strong>
                  {question.context && <p>{question.context}</p>}
                  {question.options && question.options.length > 0 ? (
                    <div className="question-options">
                      {question.options.map((option) => (
                        <button
                          type="button"
                          className="button secondary"
                          disabled={reviewing !== null}
                          key={option}
                          onClick={() => void answerQuestion(question.id, option)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="question-answer">
                      <textarea
                        value={answers[question.id] ?? ""}
                        placeholder="Type your answer"
                        disabled={reviewing !== null}
                        onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                      />
                      <button
                        type="button"
                        className="button primary"
                        disabled={reviewing !== null || !(answers[question.id] ?? "").trim()}
                        onClick={() => void answerQuestion(question.id, answers[question.id] ?? "")}
                      >
                        {reviewing === "changes" ? "Sending..." : "Send Answer"}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </section>
          )}
          {!isReviewFlow && richEvents.length > 0 && (
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
          <details className="technical-events">
            <summary>
              <span>Technical events</span>
              <small>{events.length} persisted</small>
            </summary>
            <section className="event-details-list" aria-label="All session events">
              {events.map((event) => (
                <details
                  className="event-details"
                  key={event.eventId}
                  open={!isReviewFlow && (event.payload.type === "message_completed" || event.payload.type === "completed" || event.payload.type === "failed")}
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
          </details>
        </div>
        {reviewTask?.status === "DESIGN_REVIEW" && (
          <footer className="dialog-actions event-actions">
            <textarea
              className="review-feedback"
              value={feedback}
              placeholder="Describe what should change before this can be queued."
              disabled={reviewing !== null}
              onChange={(event) => setFeedback(event.target.value)}
            />
            <button
              type="button"
              className="button secondary"
              disabled={reviewing !== null || !feedback.trim()}
              onClick={() => void requestChanges()}
            >
              {reviewing === "changes" ? "Sending..." : "Request Changes"}
            </button>
            <button type="button" className="button primary" disabled={reviewing !== null} onClick={() => void approve()}>
              {reviewing === "approve" ? "Saving..." : "Approve to Queue"}
            </button>
          </footer>
        )}
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
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!startedAt) return undefined;
    setElapsedSeconds(0);
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setSaving(true);
    setStartedAt(Date.now());
    try {
      const result = await appApi().startBrainstorm({ projectId: project.id, title, description });
      await onStarted(result);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
      setStartedAt(null);
      setElapsedSeconds(0);
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
          {saving && (
            <div className="claude-progress" role="status">
              <span className="spinner" />
              <div>
                <strong>Waiting for Claude brainstorm...</strong>
                <p>Starting the session, collecting events, and saving the result locally.</p>
              </div>
              {startedAt && <span>{elapsedSeconds}s</span>}
            </div>
          )}
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

interface ProjectTasksDialogProps {
  project: Project;
  tasks: TaskSummary[];
  loading: boolean;
  executingTaskId: string | null;
  onClose(): void;
  onOpenTask(task: TaskSummary): Promise<void>;
  onRunTask(task: TaskSummary): Promise<void>;
}

function ProjectTasksDialog({
  project,
  tasks,
  loading,
  executingTaskId,
  onClose,
  onOpenTask,
  onRunTask,
}: ProjectTasksDialogProps): React.JSX.Element {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog project-tasks-dialog" role="dialog" aria-modal="true" aria-labelledby="project-tasks-title">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">PROJECT TASKS</p>
            <h2 id="project-tasks-title">{project.name}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">X</button>
        </header>
        <div className="project-tasks-body">
          {loading ? (
            <section className="loading-state compact"><div className="spinner" />Loading tasks...</section>
          ) : tasks.length === 0 ? (
            <div className="empty-review">
              <p className="eyebrow">EMPTY</p>
              <h2>No tasks in this project</h2>
              <p>New brainstorm tasks will appear here.</p>
            </div>
          ) : (
            <div className="project-task-table" role="table" aria-label="Project task list">
              <div className="project-task-head" role="row">
                <span>Task</span>
                <span>Status</span>
                <span>Activity</span>
                <span>Actions</span>
              </div>
              {tasks.map((task) => (
                <article className="project-task-row" role="row" key={task.id}>
                  <div>
                    <strong>#{task.taskNumber} {task.title}</strong>
                    <small>{task.eventCount} events</small>
                  </div>
                  <span className="project-task-status">{task.status}</span>
                  <p>{taskActivityLabel(task)}</p>
                  <div className="task-actions">
                    {task.status === "QUEUED" && (
                      <button className="text-button" disabled={executingTaskId !== null} onClick={() => void onRunTask(task)}>
                        {executingTaskId === task.id ? "Running..." : "Run"}
                      </button>
                    )}
                    <button
                      className="text-button"
                      disabled={!task.latestSessionId || task.eventCount === 0}
                      onClick={() => void onOpenTask(task)}
                    >
                      Open
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

interface ProjectStatsDialogProps {
  project: Project;
  stats: ProjectStats | undefined;
  loading: boolean;
  onClose(): void;
}

function ProjectStatsDialog({ project, stats, loading, onClose }: ProjectStatsDialogProps): React.JSX.Element {
  const statusRows = stats
    ? boardColumns.map((column) => ({
        ...column,
        count: column.statuses.reduce((total, status) => total + (stats.byStatus[status] ?? 0), 0),
      }))
    : [];

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog project-stats-dialog" role="dialog" aria-modal="true" aria-labelledby="project-stats-title">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">PROJECT STATS</p>
            <h2 id="project-stats-title">{project.name}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">X</button>
        </header>
        <div className="project-stats-body">
          {loading || !stats ? (
            <section className="loading-state compact"><div className="spinner" />Loading stats...</section>
          ) : (
            <>
              <div className="stats-hero">
                <div>
                  <span>Total tasks</span>
                  <strong>{stats.totalTasks}</strong>
                </div>
                <div>
                  <span>Completion</span>
                  <strong>{stats.completionRate}%</strong>
                </div>
                <div>
                  <span>Events</span>
                  <strong>{stats.eventCount}</strong>
                </div>
                <div>
                  <span>Specs</span>
                  <strong>{stats.specCount}</strong>
                </div>
              </div>
              <div className="stats-summary-grid">
                <article><span>Needs attention</span><strong>{stats.attentionTasks}</strong></article>
                <article><span>Queued</span><strong>{stats.queuedTasks}</strong></article>
                <article><span>Running</span><strong>{stats.runningTasks}</strong></article>
                <article><span>Done</span><strong>{stats.completedTasks}</strong></article>
                <article><span>Draft</span><strong>{stats.draftTasks}</strong></article>
                <article><span>Blocked or failed</span><strong>{stats.failedTasks}</strong></article>
              </div>
              <section className="stats-section">
                <div className="section-heading compact">
                  <h3>Workflow distribution</h3>
                  {stats.latestActivityAt && <span>Last activity {activityDateTime(stats.latestActivityAt)}</span>}
                </div>
                <div className="stats-status-list">
                  {statusRows.map((row) => (
                    <div className="stats-status-row" key={row.id}>
                      <div>
                        <strong>{row.title}</strong>
                        <span>{row.statuses.join(", ")}</span>
                      </div>
                      <strong>{row.count}</strong>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<AppView>("projects");
  const [formProject, setFormProject] = useState<Project | "new" | null>(null);
  const [taskProject, setTaskProject] = useState<Project | null>(null);
  const [projectTasksDialog, setProjectTasksDialog] = useState<Project | null>(null);
  const [projectStatsDialog, setProjectStatsDialog] = useState<Project | null>(null);
  const [projectTasks, setProjectTasks] = useState<TaskSummary[]>([]);
  const [projectTasksLoading, setProjectTasksLoading] = useState(false);
  const [projectStatsLoading, setProjectStatsLoading] = useState(false);
  const [executingTaskId, setExecutingTaskId] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
  const [brainstormResult, setBrainstormResult] = useState<BrainstormResult | null>(null);
  const [sessionEvents, setSessionEvents] = useState<AgentEventEnvelope[]>([]);
  const [eventPanelTitle, setEventPanelTitle] = useState("Last Claude test");
  const [eventViewerOpen, setEventViewerOpen] = useState(false);
  const [activeReviewTask, setActiveReviewTask] = useState<TaskSummary | null>(null);
  const [activeSpec, setActiveSpec] = useState<TaskSpec | null>(null);
  const [tasksByProject, setTasksByProject] = useState<Record<string, TaskSummary[]>>({});
  const [statsByProject, setStatsByProject] = useState<Record<string, ProjectStats>>({});
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState<keyof NotificationSettings | null>(null);
  const [testingNotification, setTestingNotification] = useState<DesktopNotificationTestKind | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      setError("");
      const loadedProjects = await projectApi().list();
      setProjects(loadedProjects);
      const active = loadedProjects.filter((project) => project.enabled);
      const [taskEntries, statsEntries] = await Promise.all([
        Promise.all(active.map(async (project) => [project.id, await appApi().listTasks(project.id)] as const)),
        Promise.all(active.map(async (project) => [project.id, await appApi().getProjectStats(project.id)] as const)),
      ]);
      setTasksByProject(Object.fromEntries(taskEntries));
      setStatsByProject(Object.fromEntries(statsEntries));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void loadProjects(), [loadProjects]);

  useEffect(() => {
    void appApi()
      .getNotificationSettings()
      .then(setNotificationSettings)
      .catch((caught) => setError(errorMessage(caught)));
  }, []);

  useEffect(() => {
    if (loading || projects.length === 0) return undefined;
    const interval = window.setInterval(() => {
      void (async () => {
        const active = projects.filter((project) => project.enabled);
        if (active.length === 0) return;
        const [taskEntries, statsEntries] = await Promise.all([
          Promise.all(active.map(async (project) => [project.id, await appApi().listTasks(project.id)] as const)),
          Promise.all(active.map(async (project) => [project.id, await appApi().getProjectStats(project.id)] as const)),
        ]);
        const nextTasksByProject = Object.fromEntries(taskEntries);
        setTasksByProject(nextTasksByProject);
        setStatsByProject(Object.fromEntries(statsEntries));
        if (projectTasksDialog) {
          setProjectTasks(await appApi().listTasks(projectTasksDialog.id, null));
        }

        if (!eventViewerOpen || !activeReviewTask) return;
        const updatedTask = nextTasksByProject[activeReviewTask.projectId]?.find(
          (task) => task.id === activeReviewTask.id,
        );
        if (!updatedTask) return;
        setActiveReviewTask(updatedTask);
        if (!updatedTask.latestSessionId) return;

        const [events, spec] = await Promise.all([
          appApi().listSessionEvents(updatedTask.latestSessionId),
          appApi().getLatestSpec(updatedTask.id),
        ]);
        setSessionEvents(events);
        setActiveSpec(spec);
      })().catch((caught) => console.error("Failed to refresh task activity.", caught));
    }, 4000);

    return () => window.clearInterval(interval);
  }, [activeReviewTask, eventViewerOpen, loading, projectTasksDialog, projects]);

  const loadProjectTasksDialog = useCallback(async (project: Project): Promise<void> => {
    setProjectStatsDialog(null);
    setProjectTasksDialog(project);
    setProjectTasksLoading(true);
    setError("");
    try {
      setProjectTasks(await appApi().listTasks(project.id, null));
    } catch (caught) {
      setError(errorMessage(caught));
      setProjectTasks([]);
    } finally {
      setProjectTasksLoading(false);
    }
  }, []);

  const loadProjectStatsDialog = useCallback(async (project: Project): Promise<void> => {
    setProjectTasksDialog(null);
    setProjectTasks([]);
    setProjectStatsDialog(project);
    setProjectStatsLoading(true);
    setError("");
    try {
      const stats = await appApi().getProjectStats(project.id);
      setStatsByProject((current) => ({ ...current, [project.id]: stats }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setProjectStatsLoading(false);
    }
  }, []);

  async function archive(project: Project): Promise<void> {
    if (!window.confirm(`Archive ${project.name}? You can keep its local files.`)) return;
    try {
      await projectApi().archive(project.id);
      await loadProjects();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function handleBrainstormStarted(result: BrainstormResult): Promise<void> {
    setExecutionResult(null);
    setBrainstormResult(result);
    setEventPanelTitle("Last brainstorm");
    setSessionEvents(await appApi().listSessionEvents(result.sessionId));
    setActiveReviewTask(null);
    setActiveSpec(result.spec ?? null);
    setEventViewerOpen(true);
    await loadProjects();
  }

  async function viewTaskEvents(task: TaskSummary): Promise<void> {
    if (!task.latestSessionId) return;
    setError("");
    setExecutionResult(null);
    setBrainstormResult(null);
    setProjectTasksDialog(null);
    setProjectTasks([]);
    setProjectStatsDialog(null);
    try {
      setEventPanelTitle(`Task #${task.taskNumber}: ${task.title}`);
      const [events, spec] = await Promise.all([
        appApi().listSessionEvents(task.latestSessionId),
        appApi().getLatestSpec(task.id),
      ]);
      setSessionEvents(events);
      setActiveSpec(spec);
      setActiveReviewTask(task);
      setEventViewerOpen(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function reviewTask(task: TaskSummary, decision: "approve" | "changes"): Promise<void> {
    setError("");
    try {
      await appApi().reviewTask({ taskId: task.id, decision });
      await loadProjects();
      setActiveReviewTask(null);
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    }
  }

  async function startTaskExecution(task: TaskSummary): Promise<void> {
    setExecutingTaskId(task.id);
    setError("");
    setBrainstormResult(null);
    setExecutionResult(null);
    try {
      const result = await appApi().startTaskExecution(task.id);
      const [events, projectTasks, projectStats] = await Promise.all([
        appApi().listSessionEvents(result.sessionId),
        appApi().listTasks(task.projectId),
        appApi().getProjectStats(task.projectId),
      ]);
      const openProjectTasks =
        projectTasksDialog?.id === task.projectId ? await appApi().listTasks(task.projectId, null) : null;
      setExecutionResult(result);
      setEventPanelTitle(`Task #${task.taskNumber}: ${task.title}`);
      setSessionEvents(events);
      setActiveSpec(null);
      setActiveReviewTask(null);
      setTasksByProject((current) => ({ ...current, [task.projectId]: projectTasks }));
      setStatsByProject((current) => ({ ...current, [task.projectId]: projectStats }));
      if (openProjectTasks) setProjectTasks(openProjectTasks);
      setEventViewerOpen(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setExecutingTaskId(null);
    }
  }

  async function requestChanges(task: TaskSummary, feedback: string): Promise<void> {
    setError("");
    try {
      const result = await appApi().reviseBrainstorm({ taskId: task.id, feedback });
      const [events, spec] = await Promise.all([
        appApi().listSessionEvents(result.sessionId),
        appApi().getLatestSpec(task.id),
      ]);
      setBrainstormResult(result);
      setEventPanelTitle(`Task #${task.taskNumber}: ${task.title}`);
      setSessionEvents(events);
      setActiveSpec(spec);
      await loadProjects();
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    }
  }

  async function answerQuestion(task: TaskSummary, questionId: string, answer: string): Promise<void> {
    setError("");
    try {
      const result = await appApi().answerQuestion({ taskId: task.id, questionId, answer });
      const [events, spec, projectTasks, projectStats] = await Promise.all([
        appApi().listSessionEvents(result.sessionId),
        appApi().getLatestSpec(task.id),
        appApi().listTasks(task.projectId),
        appApi().getProjectStats(task.projectId),
      ]);
      setBrainstormResult(result);
      setEventPanelTitle(`Task #${task.taskNumber}: ${task.title}`);
      setSessionEvents(events);
      setActiveSpec(spec);
      setTasksByProject((current) => ({ ...current, [task.projectId]: projectTasks }));
      setStatsByProject((current) => ({ ...current, [task.projectId]: projectStats }));
      setActiveReviewTask(projectTasks.find((candidate) => candidate.id === task.id) ?? null);
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    }
  }

  async function updateNotificationSetting(key: keyof NotificationSettings, value: boolean): Promise<void> {
    if (!notificationSettings) return;
    const previous = notificationSettings;
    const next = { ...notificationSettings, [key]: value };
    setNotificationSettings(next);
    setSettingsSaving(key);
    setError("");
    try {
      setNotificationSettings(await appApi().updateNotificationSettings(next));
    } catch (caught) {
      setNotificationSettings(previous);
      setError(errorMessage(caught));
    } finally {
      setSettingsSaving(null);
    }
  }

  async function testNotification(kind: DesktopNotificationTestKind): Promise<void> {
    setTestingNotification(kind);
    setError("");
    try {
      await appApi().testDesktopNotification(kind);
      await new Promise((resolve) => window.setTimeout(resolve, 600));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setTestingNotification(null);
    }
  }

  const activeProjects = projects.filter((project) => project.enabled);
  const archivedProjects = projects.filter((project) => !project.enabled);
  const reviewTasks: ReviewTask[] = activeProjects.flatMap((project) =>
    (tasksByProject[project.id] ?? [])
      .filter((task) => task.status === "DESIGN_REVIEW" || task.status === "WAITING_USER")
      .map((task) => ({ project, task })),
  ).sort((left, right) => Date.parse(right.task.latestActivityAt) - Date.parse(left.task.latestActivityAt));
  const boardTasks: ReviewTask[] = activeProjects.flatMap((project) =>
    (tasksByProject[project.id] ?? []).map((task) => ({ project, task })),
  ).sort((left, right) => Date.parse(right.task.latestActivityAt) - Date.parse(left.task.latestActivityAt));
  const historyTasks = boardTasks.filter(({ task }) =>
    ["DONE", "FAILED", "INTERRUPTED", "CANCELLED"].includes(task.status),
  );
  const hasModal = Boolean(formProject || taskProject || projectTasksDialog || projectStatsDialog || eventViewerOpen);

  return (
    <div className={hasModal ? "app-shell modal-open" : "app-shell"}>
      <div className={hasModal ? "window-top-fill modal" : "window-top-fill"} aria-hidden="true" />
      <div className="window-drag-region" aria-hidden="true" />
      <aside className="sidebar">
        <Logo />
        <nav aria-label="Main navigation">
          <button className={view === "projects" ? "nav-item active" : "nav-item"} onClick={() => setView("projects")}>
            <span className="nav-icon">&lt;&gt;</span>Projects
          </button>
          <button className={view === "attention" ? "nav-item active" : "nav-item"} onClick={() => setView("attention")}>
            <span className="nav-icon">!</span>Attention
            {reviewTasks.length > 0 && <span className="nav-count">{reviewTasks.length}</span>}
          </button>
          <button className={view === "board" ? "nav-item active" : "nav-item"} onClick={() => setView("board")}>
            <span className="nav-icon">=</span>Board
            {boardTasks.length > 0 && <span className="nav-count">{boardTasks.length}</span>}
          </button>
          <button className={view === "history" ? "nav-item active" : "nav-item"} onClick={() => setView("history")}>
            <span className="nav-icon">#</span>History
            {historyTasks.length > 0 && <span className="nav-count">{historyTasks.length}</span>}
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            className={view === "settings" ? "nav-item sidebar-settings active" : "nav-item sidebar-settings"}
            onClick={() => setView("settings")}
          >
            <span className="nav-icon">*</span>Settings
          </button>
          <div className="local-badge"><span className="status-dot" />Local only</div>
          <p>Phase 1 - Projects</p>
        </div>
      </aside>

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">{viewEyebrow(view)}</p>
            <h1>{viewTitle(view)}</h1>
            <p className="subtitle">{viewSubtitle(view)}</p>
          </div>
          {view === "projects" && (
            <button className="button primary" onClick={() => setFormProject("new")}><span>+</span>Add project</button>
          )}
        </header>

        {error && <div className="error-banner page-error" role="alert">{error}<button onClick={() => void loadProjects()}>Try again</button></div>}
        {brainstormResult && (
          <div className="success-banner" role="status">
            Brainstorm saved {brainstormResult.eventCount} events. Session {brainstormResult.providerSessionId}.
          </div>
        )}
        {executionResult && (
          <div className="success-banner" role="status">
            Execution saved {executionResult.eventCount} events. Session {executionResult.providerSessionId}.
          </div>
        )}
        {loading ? (
          <section className="loading-state"><div className="spinner" />Loading projects...</section>
        ) : view === "settings" ? (
          <section className="settings-section">
            {!notificationSettings ? (
              <section className="loading-state compact"><div className="spinner" />Loading settings...</section>
            ) : (
              <div className="settings-panel">
                <div className="settings-group">
                  <div>
                    <h2>Desktop notifications</h2>
                    <p>Native Windows toasts from local Anubis events.</p>
                  </div>
                  <label className="toggle-row">
                    <span>
                      <strong>Enable desktop notifications</strong>
                      <small>Turns all Windows notifications on or off.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={notificationSettings.desktopEnabled}
                      disabled={settingsSaving !== null}
                      onChange={(event) => void updateNotificationSetting("desktopEnabled", event.currentTarget.checked)}
                    />
                  </label>
                  <label className="toggle-row">
                    <span>
                      <strong>Play notification sound</strong>
                      <small>Uses the Windows toast sound when a popup appears.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={notificationSettings.desktopSound}
                      disabled={!notificationSettings.desktopEnabled || settingsSaving !== null}
                      onChange={(event) => void updateNotificationSetting("desktopSound", event.currentTarget.checked)}
                    />
                  </label>
                </div>

                <div className="settings-list">
                  {[
                    ["brainstormNeedsAnswer", "Needs your answer", "When a brainstorm asks a question and waits for you."],
                    ["brainstormReadyForReview", "Spec ready for review", "When Claude finishes a brainstorm without pending questions."],
                    ["brainstormFailed", "Brainstorm failed", "When a brainstorm ends with a provider or runtime failure."],
                    ["executionCompleted", "Execution completed", "When an approved task finishes successfully."],
                    ["executionFailed", "Execution failed", "When an execution fails or is interrupted."],
                  ].map(([key, title, description]) => {
                    const typedKey = key as DesktopNotificationTestKind;
                    return (
                    <div className="toggle-row" key={key}>
                      <span>
                        <strong>{title}</strong>
                        <small>{description}</small>
                      </span>
                      <button
                        type="button"
                        className="button secondary compact"
                        disabled={!notificationSettings.desktopEnabled || testingNotification !== null}
                        onClick={() => void testNotification(typedKey)}
                      >
                        {testingNotification === typedKey ? "Testing..." : "Test"}
                      </button>
                      <input
                        type="checkbox"
                        checked={notificationSettings[typedKey]}
                        disabled={!notificationSettings.desktopEnabled || settingsSaving !== null}
                        onChange={(event) =>
                          void updateNotificationSetting(typedKey, event.currentTarget.checked)
                        }
                      />
                    </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        ) : view === "attention" ? (
          <section className="review-section">
            {reviewTasks.length === 0 ? (
              <div className="empty-review">
                <p className="eyebrow">CLEAR</p>
                <h2>No design reviews waiting</h2>
                <p>Questions and completed specs will appear here before tasks are queued for implementation.</p>
              </div>
            ) : (
              <div className="review-list">
                {reviewTasks.map(({ project, task }) => (
                  <article className="review-row" key={task.id}>
                    <div>
                      <span className="review-project">{project.name}</span>
                      <h2>#{task.taskNumber} {task.title}</h2>
                      <p>
                        {task.status} - {task.pendingQuestions.length} questions - {task.eventCount} events
                      </p>
                      <span className="review-latest">{taskActivityLabel(task)}</span>
                      <span className="review-activity">Last activity {activityTime(task.latestActivityAt)}</span>
                    </div>
                    <button
                      className="button secondary"
                      disabled={!task.latestSessionId || task.eventCount === 0}
                      onClick={() => void viewTaskEvents(task)}
                    >
                      {task.status === "WAITING_USER" ? "Answer" : "Review"}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : view === "board" ? (
          <section className="board-section">
            <div className="board-grid">
              {boardColumns.map((column) => {
                const columnTasks = boardTasks.filter(({ task }) => column.statuses.includes(task.status));
                return (
                  <section className="board-column" key={column.id} aria-label={column.title}>
                    <header>
                      <h2>{column.title}</h2>
                      <span>{columnTasks.length}</span>
                    </header>
                    <div className="board-card-list">
                      {columnTasks.length === 0 ? (
                        <p>No tasks</p>
                      ) : (
                        columnTasks.map(({ project, task }) => (
                          <article className="board-card" key={task.id}>
                            <span className="board-project">{project.name}</span>
                            <h3>#{task.taskNumber} {task.title}</h3>
                            <p>{taskActivityLabel(task)}</p>
                            <footer>
                              <span>{task.status}</span>
                              <div className="task-actions">
                                {task.status === "QUEUED" && (
                                  <button
                                    className="text-button"
                                    disabled={executingTaskId !== null}
                                    onClick={() => void startTaskExecution(task)}
                                  >
                                    {executingTaskId === task.id ? "Running..." : "Run"}
                                  </button>
                                )}
                                <button
                                  className="text-button"
                                  disabled={!task.latestSessionId || task.eventCount === 0}
                                  onClick={() => void viewTaskEvents(task)}
                                >
                                  Open
                                </button>
                              </div>
                            </footer>
                          </article>
                        ))
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </section>
        ) : view === "history" ? (
          <section className="history-section">
            {historyTasks.length === 0 ? (
              <div className="empty-review">
                <p className="eyebrow">NO RUNS</p>
                <h2>No task history yet</h2>
                <p>Completed, failed, interrupted, and cancelled tasks will appear here.</p>
              </div>
            ) : (
              <div className="history-list">
                {historyTasks.map(({ project, task }) => (
                  <article className="history-row" key={task.id}>
                    <div className="history-status" data-status={task.status}>{task.status}</div>
                    <div>
                      <span className="review-project">{project.name}</span>
                      <h2>#{task.taskNumber} {task.title}</h2>
                      <p>{taskActivityLabel(task)}</p>
                      <span>Last activity {activityTime(task.latestActivityAt)} - {task.eventCount} events</span>
                    </div>
                    <button
                      className="button secondary"
                      disabled={!task.latestSessionId || task.eventCount === 0}
                      onClick={() => void viewTaskEvents(task)}
                    >
                      Open
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
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
              {activeProjects.map((project) => {
                const stats = statsByProject[project.id];
                return (
                  <article className="project-card" key={project.id}>
                    <div className="project-card-top">
                      <div className="project-symbol">{project.name.slice(0, 2).toUpperCase()}</div>
                      <div className="project-state"><span className="status-dot" />Idle</div>
                    </div>
                    <h3>{project.name}</h3>
                    <p className="project-path" title={project.path}>{project.path}</p>
                    <div className="tags"><span>Claude</span><span>Superpowers</span></div>
                    {stats && (
                      <div className="project-stats-strip" aria-label={`${project.name} stats`}>
                        <span><strong>{stats.totalTasks}</strong>Tasks</span>
                        <span><strong>{stats.attentionTasks}</strong>Attention</span>
                        <span><strong>{stats.queuedTasks}</strong>Queued</span>
                        <span><strong>{stats.completionRate}%</strong>Done</span>
                      </div>
                    )}
                    <div className="task-list">
                      {(tasksByProject[project.id] ?? []).length === 0 ? (
                        <p>No tasks yet</p>
                      ) : (
                        (tasksByProject[project.id] ?? []).slice(0, 3).map((task) => (
                          <div className="task-row" key={task.id}>
                            <div>
                              <strong>#{task.taskNumber} {task.title}</strong>
                              <span>
                                {task.status} - {task.latestSessionStatus ?? "NO_SESSION"} - {task.eventCount} events
                              </span>
                            </div>
                            <div className="task-actions">
                              {task.status === "QUEUED" && (
                                <button
                                  className="text-button"
                                  disabled={executingTaskId !== null}
                                  onClick={() => void startTaskExecution(task)}
                                >
                                  {executingTaskId === task.id ? "Running..." : "Run"}
                                </button>
                              )}
                              <button
                                className="text-button"
                                disabled={!task.latestSessionId || task.eventCount === 0}
                                onClick={() => void viewTaskEvents(task)}
                              >
                                View Events
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                    <footer>
                      <span>{stats?.latestActivityAt ? `Last ${activityTime(stats.latestActivityAt)}` : "Ready for tasks"}</span>
                      <div className="project-actions">
                        <button
                          className="text-button"
                          onClick={() => setTaskProject(project)}
                        >
                          New Task
                        </button>
                        <button
                          className="text-button"
                          onClick={() => void loadProjectTasksDialog(project)}
                        >
                          All tasks
                        </button>
                        <button
                          className="text-button"
                          onClick={() => void loadProjectStatsDialog(project)}
                        >
                          Stats
                        </button>
                        <button className="text-button" onClick={() => setFormProject(project)}>Edit</button>
                        <button className="text-button danger" onClick={() => void archive(project)}>Archive</button>
                      </div>
                    </footer>
                  </article>
                );
              })}
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
      {projectTasksDialog && (
        <ProjectTasksDialog
          project={projectTasksDialog}
          tasks={projectTasks}
          loading={projectTasksLoading}
          executingTaskId={executingTaskId}
          onClose={() => {
            setProjectTasksDialog(null);
            setProjectTasks([]);
          }}
          onOpenTask={viewTaskEvents}
          onRunTask={startTaskExecution}
        />
      )}
      {projectStatsDialog && (
        <ProjectStatsDialog
          project={projectStatsDialog}
          stats={statsByProject[projectStatsDialog.id]}
          loading={projectStatsLoading}
          onClose={() => setProjectStatsDialog(null)}
        />
      )}
      {eventViewerOpen && sessionEvents.length > 0 && (
        <EventViewer
          title={eventPanelTitle}
          events={sessionEvents}
          {...(activeSpec ? { spec: activeSpec } : {})}
          onClose={() => setEventViewerOpen(false)}
          onApprove={(task) => reviewTask(task, "approve")}
          onRequestChanges={requestChanges}
          onAnswerQuestion={answerQuestion}
          {...(activeReviewTask ? { reviewTask: activeReviewTask } : {})}
        />
      )}
    </div>
  );
}
