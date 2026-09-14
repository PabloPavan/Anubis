import type { DatabaseSync } from "node:sqlite";
import {
  type AgentEvent,
  parseAgentEventEnvelope,
  type AgentEventEnvelope,
} from "../../shared/agent-events";
import {
  parseAttemptStatus,
  parseAgentEffortOption,
  parseAgentModelOption,
  parseSessionStatus,
  parseSessionType,
  parseTaskStatus,
  taskStatuses,
  type AgentSession,
  type AgentEffortOption,
  type AgentModelOption,
  type AttemptStatus,
  type ExecutionAttempt,
  type Task,
  type TaskStatus,
} from "../../shared/tasks";
import type { ProviderId, WorkflowId } from "../../shared/projects";
import type { AgentUsageSummary, ProjectMemory, ProjectStats, TaskPlan, TaskSpec, TaskSummary } from "../../shared/app";

interface TaskRow {
  id: string;
  project_id: string;
  task_number: number;
  title: string;
  description: string;
  status: TaskStatus;
  provider: ProviderId;
  workflow: WorkflowId;
  model: AgentModelOption;
  effort: AgentEffortOption;
  revision: number;
  auto_resume_at: string | null;
  last_failure_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface AttemptRow {
  id: string;
  task_id: string;
  attempt_number: number;
  status: AttemptStatus;
  started_at: string;
  ended_at: string | null;
  outcome_summary: string | null;
}

interface SessionRow {
  id: string;
  task_id: string;
  attempt_id: string | null;
  provider: ProviderId;
  provider_session_id: string | null;
  type: AgentSession["type"];
  status: AgentSession["status"];
  created_at: string;
  suspended_at: string | null;
  ended_at: string | null;
}

interface EventRow {
  id: string;
  project_id: string;
  task_id: string;
  session_id: string;
  sequence: number;
  schema_version: 1;
  payload_json: string;
  persistence: AgentEventEnvelope["persistence"];
  occurred_at: string;
}

interface TaskSummaryRow {
  id: string;
  project_id: string;
  task_number: number;
  title: string;
  description: string;
  status: TaskStatus;
  model: AgentModelOption;
  effort: AgentEffortOption;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  latest_activity_at: string;
  latest_event_type: AgentEvent["type"] | null;
  latest_event_payload_json: string | null;
  latest_session_id: string | null;
  latest_provider_session_id: string | null;
  latest_session_type: AgentSession["type"] | null;
  latest_session_status: AgentSession["status"] | null;
  latest_spec_version: number | null;
  latest_spec_approved_at: string | null;
  auto_resume_at: string | null;
  last_failure_code: string | null;
  context_task_ids: string | null;
  event_count: number;
}

interface TaskSpecRow {
  id: string;
  task_id: string;
  version: number;
  content_markdown: string;
  sha256: string;
  source_session_id: string | null;
  approved_at: string | null;
  created_at: string;
}

interface TaskPlanRow {
  id: string;
  task_id: string;
  version: number;
  content_markdown: string;
  sha256: string;
  source_session_id: string | null;
  created_at: string;
}

interface StatusCountRow {
  status: TaskStatus;
  count: number;
}

interface CompletedDurationRow {
  started_at: string | null;
  completed_at: string | null;
}

interface ProjectMemoryRow {
  project_id: string;
  content_markdown: string;
  updated_at: string;
}

export class AgentJournalConflictError extends Error {
  constructor(message = "Agent journal record conflicts with existing data.") {
    super(message);
    this.name = "AgentJournalConflictError";
  }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("constraint failed");
}

function optional(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

function durationSeconds(start: string | null | undefined, end: string | null | undefined): number {
  if (!start || !end) return 0;
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime <= startTime) return 0;
  return Math.round((endTime - startTime) / 1000);
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    taskNumber: row.task_number,
    title: row.title,
    description: row.description,
    status: row.status,
    provider: row.provider,
    workflow: row.workflow,
    model: parseAgentModelOption(row.model),
    effort: parseAgentEffortOption(row.effort),
    revision: row.revision,
    ...(row.auto_resume_at ? { autoResumeAt: row.auto_resume_at } : {}),
    ...(row.last_failure_code ? { lastFailureCode: row.last_failure_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function toAttempt(row: AttemptRow): ExecutionAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    startedAt: row.started_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    ...(row.outcome_summary ? { outcomeSummary: row.outcome_summary } : {}),
  };
}

function toSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    provider: row.provider,
    ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
    ...(row.suspended_at ? { suspendedAt: row.suspended_at } : {}),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
  };
}

function toEvent(row: EventRow): AgentEventEnvelope {
  return parseAgentEventEnvelope({
    eventId: row.id,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    sequence: row.sequence,
    persistence: row.persistence,
    payload: JSON.parse(row.payload_json),
  });
}

function eventPreview(payloadJson: string | null): { type?: AgentEvent["type"]; text?: string } {
  if (!payloadJson) return {};
  const payload = JSON.parse(payloadJson) as AgentEvent;
  const preview = (type: AgentEvent["type"], text?: string): { type: AgentEvent["type"]; text?: string } => ({
    type,
    ...(text ? { text } : {}),
  });
  switch (payload.type) {
    case "user_message":
      return preview(payload.type, payload.text);
    case "question_asked":
      return preview(payload.type, payload.question.prompt);
    case "question_answered":
      return preview(payload.type, "Question answered");
    case "message_completed":
      return preview(payload.type, payload.text);
    case "completed":
      return preview(payload.type, payload.summary);
    case "failed":
      return preview(payload.type, payload.error.message);
    case "session_finished":
      return preview(payload.type, payload.outcome);
    case "stage_changed":
      return preview(payload.type, payload.stage);
    case "thinking_status":
      return preview(payload.type, payload.text);
    case "rate_limit_updated":
      return preview(
        payload.type,
        [
          payload.status,
          payload.rateLimitType,
          payload.utilization !== undefined ? `${payload.utilization}% used` : "",
          payload.resetsAt ? `resets at ${payload.resetsAt}` : "",
        ]
          .filter(Boolean)
          .join(" - "),
      );
    case "usage_updated":
      return preview(payload.type, `$${payload.usage.totalCostUsd.toFixed(4)} estimated`);
    case "context_updated":
      return preview(payload.type, `${payload.context.percentage}% context`);
    case "execution_reviewed":
      return preview(payload.type, payload.feedback ?? payload.decision);
    default:
      return preview(payload.type);
  }
}

function toTaskSummary(row: TaskSummaryRow): TaskSummary {
  const latestEvent = eventPreview(row.latest_event_payload_json);
  return {
    id: row.id,
    projectId: row.project_id,
    taskNumber: row.task_number,
    title: row.title,
    description: row.description,
    status: row.status,
    model: parseAgentModelOption(row.model),
    effort: parseAgentEffortOption(row.effort),
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(durationSeconds(row.started_at, row.completed_at) > 0
      ? { completedDurationSeconds: durationSeconds(row.started_at, row.completed_at) }
      : {}),
    latestActivityAt: row.latest_activity_at,
    ...(latestEvent.type ? { latestEventType: latestEvent.type } : {}),
    ...(latestEvent.text ? { latestEventText: latestEvent.text } : {}),
    ...(row.latest_session_id ? { latestSessionId: row.latest_session_id } : {}),
    ...(row.latest_provider_session_id ? { latestProviderSessionId: row.latest_provider_session_id } : {}),
    ...(row.latest_session_type ? { latestSessionType: row.latest_session_type } : {}),
    ...(row.latest_session_status ? { latestSessionStatus: row.latest_session_status } : {}),
    ...(row.latest_spec_version ? { latestSpecVersion: row.latest_spec_version } : {}),
    ...(row.latest_spec_approved_at ? { latestSpecApprovedAt: row.latest_spec_approved_at } : {}),
    ...(row.auto_resume_at ? { autoResumeAt: row.auto_resume_at } : {}),
    ...(row.last_failure_code ? { lastFailureCode: row.last_failure_code } : {}),
    contextTaskIds: row.context_task_ids ? row.context_task_ids.split(",").filter(Boolean) : [],
    pendingQuestions: [],
    eventCount: row.event_count,
  };
}

function toTaskSpec(row: TaskSpecRow): TaskSpec {
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    contentMarkdown: row.content_markdown,
    sha256: row.sha256,
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    ...(row.approved_at ? { approvedAt: row.approved_at } : {}),
    createdAt: row.created_at,
  };
}

function toTaskPlan(row: TaskPlanRow): TaskPlan {
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    contentMarkdown: row.content_markdown,
    sha256: row.sha256,
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    createdAt: row.created_at,
  };
}

function emptyStatusCounts(): Record<TaskStatus, number> {
  return Object.fromEntries(taskStatuses.map((status) => [status, 0])) as Record<TaskStatus, number>;
}

function toProjectMemory(row: ProjectMemoryRow): ProjectMemory {
  return {
    projectId: row.project_id,
    contentMarkdown: row.content_markdown,
    updatedAt: row.updated_at,
  };
}

function emptyUsageSummary(): AgentUsageSummary {
  return {
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    sessions: 0,
    byModel: {},
  };
}

function addModelUsage(
  usage: AgentUsageSummary,
  model: string,
  delta: AgentUsageSummary["byModel"][string],
): void {
  const current = usage.byModel[model] ?? {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
  };
  usage.byModel[model] = {
    inputTokens: current.inputTokens + delta.inputTokens,
    outputTokens: current.outputTokens + delta.outputTokens,
    thinkingTokens: current.thinkingTokens + delta.thinkingTokens,
    cacheReadInputTokens: current.cacheReadInputTokens + delta.cacheReadInputTokens,
    cacheCreationInputTokens: current.cacheCreationInputTokens + delta.cacheCreationInputTokens,
    webSearchRequests: current.webSearchRequests + delta.webSearchRequests,
    costUsd: current.costUsd + delta.costUsd,
  };
}

function summarizeUsage(events: AgentEventEnvelope[]): AgentUsageSummary {
  const usage = emptyUsageSummary();
  const latestUsageBySession = new Map<string, AgentEventEnvelope<Extract<AgentEvent, { type: "usage_updated" }>>>();
  let latestContext: AgentEventEnvelope<Extract<AgentEvent, { type: "context_updated" }>> | undefined;

  for (const event of events) {
    if (event.payload.type === "usage_updated") {
      latestUsageBySession.set(event.sessionId, event as AgentEventEnvelope<Extract<AgentEvent, { type: "usage_updated" }>>);
    }
    if (event.payload.type === "context_updated") {
      latestContext = event as AgentEventEnvelope<Extract<AgentEvent, { type: "context_updated" }>>;
    }
  }

  for (const event of latestUsageBySession.values()) {
    const snapshot = event.payload.usage;
    usage.totalCostUsd += snapshot.totalCostUsd;
    usage.inputTokens += snapshot.inputTokens;
    usage.outputTokens += snapshot.outputTokens;
    usage.thinkingTokens += snapshot.thinkingTokens;
    usage.cacheReadInputTokens += snapshot.cacheReadInputTokens;
    usage.cacheCreationInputTokens += snapshot.cacheCreationInputTokens;
    usage.webSearchRequests += snapshot.webSearchRequests;
    usage.sessions += 1;
    for (const [model, modelUsage] of Object.entries(snapshot.modelUsage)) {
      addModelUsage(usage, model, {
        inputTokens: modelUsage.inputTokens,
        outputTokens: modelUsage.outputTokens,
        thinkingTokens: modelUsage.thinkingTokens ?? 0,
        cacheReadInputTokens: modelUsage.cacheReadInputTokens,
        cacheCreationInputTokens: modelUsage.cacheCreationInputTokens,
        webSearchRequests: modelUsage.webSearchRequests,
        costUsd: modelUsage.costUsd,
      });
    }
  }

  if (latestContext) {
    usage.latestContext = latestContext.payload.context;
  }
  return usage;
}

export class AgentJournalRepository {
  constructor(private readonly database: DatabaseSync) {}

  nextTaskNumber(projectId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(task_number), 0) + 1 AS task_number FROM tasks WHERE project_id = ?")
      .get(projectId) as { task_number: number };
    return row.task_number;
  }

  createTask(input: {
    id: string;
    projectId: string;
    taskNumber: number;
    title: string;
    description?: string;
    status: TaskStatus;
    provider: ProviderId;
    workflow: WorkflowId;
    model?: AgentModelOption;
    effort?: AgentEffortOption;
    position: number;
    now: string;
  }): Task {
    const status = parseTaskStatus(input.status);
    try {
      this.database
        .prepare(`
          INSERT INTO tasks(
            id, project_id, task_number, title, description, status, provider, workflow,
            model, effort, position, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.id,
          input.projectId,
          input.taskNumber,
          input.title,
          input.description ?? "",
          status,
          input.provider,
          input.workflow,
          input.model ?? "default",
          input.effort ?? "default",
          input.position,
          input.now,
          input.now,
        );
    } catch (error) {
      if (isConstraintError(error)) throw new AgentJournalConflictError();
      throw error;
    }
    return this.getTask(input.id);
  }

  replaceTaskContextLinks(taskId: string, sourceTaskIds: string[], createdAt = new Date().toISOString()): void {
    this.database.prepare("DELETE FROM task_context_links WHERE task_id = ?").run(taskId);
    const insert = this.database.prepare(`
      INSERT INTO task_context_links(task_id, source_task_id, mode, created_at)
      VALUES (?, ?, 'summary', ?)
    `);
    sourceTaskIds.forEach((sourceTaskId) => insert.run(taskId, sourceTaskId, createdAt));
  }

  listTaskContextIds(taskId: string): string[] {
    const rows = this.database
      .prepare("SELECT source_task_id FROM task_context_links WHERE task_id = ? ORDER BY created_at, source_task_id")
      .all(taskId) as unknown as Array<{ source_task_id: string }>;
    return rows.map((row) => row.source_task_id);
  }

  getTask(id: string): Task {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    if (!row) throw new AgentJournalConflictError("Task not found.");
    return toTask(row);
  }

  updateTaskStatus(id: string, statusInput: TaskStatus, updatedAt = new Date().toISOString()): Task {
    const status = parseTaskStatus(statusInput);
    this.database.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, id);
    return this.getTask(id);
  }

  updateDraftTask(
    id: string,
    input: {
      title: string;
      description: string;
      model: AgentModelOption;
      effort: AgentEffortOption;
      updatedAt?: string;
    },
  ): Task {
    const result = this.database
      .prepare(`
        UPDATE tasks
        SET title = ?,
            description = ?,
            model = ?,
            effort = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'DRAFT'
      `)
      .run(input.title, input.description, input.model, input.effort, input.updatedAt ?? new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new AgentJournalConflictError("Only draft tasks can be edited.");
    return this.getTask(id);
  }

  beginQueuedTaskExecution(id: string, startedAt = new Date().toISOString()): Task {
    const result = this.database
      .prepare(`
        UPDATE tasks
        SET status = 'EXECUTING',
            started_at = COALESCE(started_at, ?),
            auto_resume_at = NULL,
            updated_at = ?
        WHERE id = ?
          AND status = 'QUEUED'
          AND is_paused = 0
      `)
      .run(startedAt, startedAt, id);
    if (Number(result.changes) !== 1) {
      throw new AgentJournalConflictError("Queued task could not be claimed for execution.");
    }
    return this.getTask(id);
  }

  beginResumedTaskExecution(id: string, startedAt = new Date().toISOString()): Task {
    const result = this.database
      .prepare(`
        UPDATE tasks
        SET status = 'EXECUTING',
            auto_resume_at = NULL,
            updated_at = ?
        WHERE id = ?
          AND status = 'READY_TO_RESUME'
          AND is_paused = 0
      `)
      .run(startedAt, id);
    if (Number(result.changes) !== 1) {
      throw new AgentJournalConflictError("Resumable task could not be claimed for execution.");
    }
    return this.getTask(id);
  }

  completeTaskExecution(
    id: string,
    statusInput: TaskStatus,
    completedAt = new Date().toISOString(),
    recovery?: { autoResumeAt?: string; failureCode?: string },
  ): Task {
    const status = parseTaskStatus(statusInput);
    this.database
      .prepare(`
        UPDATE tasks
        SET status = ?,
            completed_at = CASE
              WHEN ? IN ('DONE', 'FAILED', 'BLOCKED', 'INTERRUPTED', 'CANCELLED') THEN ?
              ELSE completed_at
            END,
            auto_resume_at = ?,
            last_failure_code = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(status, status, completedAt, recovery?.autoResumeAt ?? null, recovery?.failureCode ?? null, completedAt, id);
    return this.getTask(id);
  }

  listRunnableQueuedTasks(limit = 10, autoResumeEnabled = false, now = new Date().toISOString()): Task[] {
    const rows = this.database
      .prepare(`
        SELECT tasks.*
        FROM tasks
        LEFT JOIN project_execution_locks AS locks
          ON locks.project_id = tasks.project_id
        WHERE (
            tasks.status = 'QUEUED'
            OR (
              ? = 1
              AND tasks.status = 'READY_TO_RESUME'
              AND tasks.auto_resume_at IS NOT NULL
              AND tasks.auto_resume_at <= ?
            )
          )
          AND tasks.is_paused = 0
          AND locks.project_id IS NULL
        ORDER BY tasks.priority DESC, tasks.position ASC, tasks.created_at ASC
        LIMIT 100
      `)
      .all(autoResumeEnabled ? 1 : 0, now) as unknown as TaskRow[];
    const projectIds = new Set<string>();
    const tasks: Task[] = [];
    for (const row of rows) {
      if (projectIds.has(row.project_id)) continue;
      projectIds.add(row.project_id);
      tasks.push(toTask(row));
      if (tasks.length >= limit) break;
    }
    return tasks;
  }

  tryAcquireProjectExecutionLock(input: {
    projectId: string;
    taskId: string;
    ownerId: string;
    acquiredAt: string;
  }): boolean {
    try {
      this.database
        .prepare(`
          INSERT INTO project_execution_locks(project_id, task_id, owner_id, acquired_at, heartbeat_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(input.projectId, input.taskId, input.ownerId, input.acquiredAt, input.acquiredAt);
      return true;
    } catch (error) {
      if (isConstraintError(error)) return false;
      throw error;
    }
  }

  releaseProjectExecutionLock(projectId: string, ownerId: string): void {
    this.database
      .prepare("DELETE FROM project_execution_locks WHERE project_id = ? AND owner_id = ?")
      .run(projectId, ownerId);
  }

  releaseAllProjectExecutionLocks(): void {
    this.database.prepare("DELETE FROM project_execution_locks").run();
  }

  countRunningTasks(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('PLANNING', 'EXECUTING', 'VERIFYING')")
      .get() as { count: number };
    return row.count;
  }

  markInterruptedRunningTasks(interruptedAt = new Date().toISOString()): number {
    const resumable = this.database
      .prepare(`
        UPDATE tasks
        SET status = 'READY_TO_RESUME',
            updated_at = ?
        WHERE status IN ('BRAINSTORMING', 'PLANNING', 'EXECUTING', 'VERIFYING')
          AND EXISTS (
            SELECT 1
            FROM sessions
            WHERE sessions.task_id = tasks.id
              AND sessions.type IN ('BRAINSTORM', 'EXECUTION')
              AND sessions.provider_session_id IS NOT NULL
          )
      `)
      .run(interruptedAt);
    const interrupted = this.database
      .prepare(`
        UPDATE tasks
        SET status = 'INTERRUPTED',
            completed_at = COALESCE(completed_at, ?),
            updated_at = ?
        WHERE status IN ('BRAINSTORMING', 'PLANNING', 'EXECUTING', 'VERIFYING')
      `)
      .run(interruptedAt, interruptedAt);
    return Number(resumable.changes) + Number(interrupted.changes);
  }

  listTasksForProject(projectId: string, limit: number | null = 20): TaskSummary[] {
    const limitClause = limit === null ? "" : "LIMIT ?";
    const rows = this.database
      .prepare(`
        SELECT
          tasks.id,
          tasks.project_id,
          tasks.task_number,
          tasks.title,
          tasks.description,
          tasks.status,
          tasks.model,
          tasks.effort,
          tasks.updated_at,
          tasks.started_at,
          tasks.completed_at,
          COALESCE(
            (
              SELECT MAX(task_events.occurred_at)
              FROM events AS task_events
              WHERE task_events.task_id = tasks.id
            ),
            latest_plan.created_at,
            latest_spec.created_at,
            tasks.updated_at
          ) AS latest_activity_at,
          (
            SELECT latest_event.type
            FROM events AS latest_event
            WHERE latest_event.task_id = tasks.id
            ORDER BY latest_event.occurred_at DESC, latest_event.created_at DESC, latest_event.sequence DESC
            LIMIT 1
          ) AS latest_event_type,
          (
            SELECT latest_event.payload_json
            FROM events AS latest_event
            WHERE latest_event.task_id = tasks.id
            ORDER BY latest_event.occurred_at DESC, latest_event.created_at DESC, latest_event.sequence DESC
            LIMIT 1
          ) AS latest_event_payload_json,
          latest_session.id AS latest_session_id,
          latest_session.provider_session_id AS latest_provider_session_id,
          latest_session.type AS latest_session_type,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM events AS finished_events
              WHERE finished_events.session_id = latest_session.id
                AND finished_events.type = 'session_finished'
            ) THEN 'ENDED'
            ELSE latest_session.status
          END AS latest_session_status,
          latest_spec.version AS latest_spec_version,
          latest_spec.approved_at AS latest_spec_approved_at,
          tasks.auto_resume_at,
          tasks.last_failure_code,
          (
            SELECT GROUP_CONCAT(task_context_links.source_task_id, ',')
            FROM task_context_links
            WHERE task_context_links.task_id = tasks.id
            ORDER BY task_context_links.created_at, task_context_links.source_task_id
          ) AS context_task_ids,
          COUNT(events.id) AS event_count
        FROM tasks
        LEFT JOIN sessions AS latest_session
          ON latest_session.id = (
            SELECT sessions.id
            FROM sessions
            WHERE sessions.task_id = tasks.id
            ORDER BY sessions.created_at DESC, sessions.rowid DESC
            LIMIT 1
          )
        LEFT JOIN events
          ON events.session_id = latest_session.id
        LEFT JOIN task_specs AS latest_spec
          ON latest_spec.id = (
            SELECT task_specs.id
            FROM task_specs
            WHERE task_specs.task_id = tasks.id
            ORDER BY task_specs.version DESC
            LIMIT 1
          )
        LEFT JOIN task_plans AS latest_plan
          ON latest_plan.id = (
            SELECT task_plans.id
            FROM task_plans
            WHERE task_plans.task_id = tasks.id
            ORDER BY task_plans.version DESC
            LIMIT 1
          )
        WHERE tasks.project_id = ?
        GROUP BY tasks.id
        ORDER BY latest_activity_at DESC, tasks.updated_at DESC, tasks.task_number DESC
        ${limitClause}
      `)
      .all(...(limit === null ? [projectId] : [projectId, limit])) as unknown as TaskSummaryRow[];
    return rows.map(toTaskSummary);
  }

  getProjectStats(projectId: string): ProjectStats {
    const statusRows = this.database
      .prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE project_id = ? GROUP BY status")
      .all(projectId) as unknown as StatusCountRow[];
    const byStatus = emptyStatusCounts();
    statusRows.forEach((row) => {
      byStatus[parseTaskStatus(row.status)] = row.count;
    });

    const eventRow = this.database.prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ?").get(projectId) as {
      count: number;
    };
    const specRow = this.database
      .prepare(`
        SELECT COUNT(task_specs.id) AS count
        FROM task_specs
        INNER JOIN tasks ON tasks.id = task_specs.task_id
        WHERE tasks.project_id = ?
      `)
      .get(projectId) as { count: number };
    const activityRow = this.database
      .prepare(`
        SELECT MAX(activity_at) AS latest_activity_at
        FROM (
          SELECT updated_at AS activity_at FROM tasks WHERE project_id = ?
          UNION ALL
          SELECT occurred_at AS activity_at FROM events WHERE project_id = ?
          UNION ALL
          SELECT task_specs.created_at AS activity_at
          FROM task_specs
          INNER JOIN tasks ON tasks.id = task_specs.task_id
          WHERE tasks.project_id = ?
          UNION ALL
          SELECT task_plans.created_at AS activity_at
          FROM task_plans
          INNER JOIN tasks ON tasks.id = task_plans.task_id
          WHERE tasks.project_id = ?
        )
      `)
      .get(projectId, projectId, projectId, projectId) as { latest_activity_at: string | null };
    const completedDurationRows = this.database
      .prepare(`
        SELECT started_at, completed_at
        FROM tasks
        WHERE project_id = ?
          AND status = 'DONE'
          AND started_at IS NOT NULL
          AND completed_at IS NOT NULL
      `)
      .all(projectId) as unknown as CompletedDurationRow[];

    const totalTasks = Object.values(byStatus).reduce((total, count) => total + count, 0);
    const completedTasks = byStatus.DONE;
    const failedTasks = byStatus.BLOCKED + byStatus.FAILED + byStatus.INTERRUPTED + byStatus.CANCELLED;
    const completedDurations = completedDurationRows
      .map((row) => durationSeconds(row.started_at, row.completed_at))
      .filter((duration) => duration > 0);
    const totalCompletedDurationSeconds = completedDurations.reduce((total, duration) => total + duration, 0);
    const averageCompletedDurationSeconds = completedDurations.length === 0
      ? 0
      : Math.round(totalCompletedDurationSeconds / completedDurations.length);
    const usage = summarizeUsage(this.listUsageEventsForProject(projectId));
    const completedHours = totalCompletedDurationSeconds / 3600;
    const costPerCompletedHourUsd = completedHours > 0 ? usage.totalCostUsd / completedHours : 0;
    return {
      projectId,
      totalTasks,
      draftTasks: byStatus.DRAFT + byStatus.BRAINSTORMING,
      attentionTasks: byStatus.WAITING_USER + byStatus.DESIGN_REVIEW + byStatus.EXECUTION_REVIEW,
      queuedTasks: byStatus.QUEUED + byStatus.READY_TO_RESUME,
      runningTasks: byStatus.PLANNING + byStatus.EXECUTING + byStatus.VERIFYING,
      completedTasks,
      failedTasks,
      eventCount: eventRow.count,
      specCount: specRow.count,
      completionRate: totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
      totalCompletedDurationSeconds,
      averageCompletedDurationSeconds,
      costPerCompletedHourUsd,
      usage,
      ...(activityRow.latest_activity_at ? { latestActivityAt: activityRow.latest_activity_at } : {}),
      byStatus,
    };
  }

  getProjectMemory(projectId: string): ProjectMemory {
    const existing = this.database.prepare("SELECT * FROM project_memory WHERE project_id = ?").get(projectId) as
      | ProjectMemoryRow
      | undefined;
    if (existing) return toProjectMemory(existing);
    const now = new Date().toISOString();
    this.database
      .prepare("INSERT INTO project_memory(project_id, content_markdown, updated_at) VALUES (?, '', ?)")
      .run(projectId, now);
    return { projectId, contentMarkdown: "", updatedAt: now };
  }

  updateProjectMemory(projectId: string, contentMarkdown: string, updatedAt = new Date().toISOString()): ProjectMemory {
    this.database
      .prepare(`
        INSERT INTO project_memory(project_id, content_markdown, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          content_markdown = excluded.content_markdown,
          updated_at = excluded.updated_at
      `)
      .run(projectId, contentMarkdown, updatedAt);
    return this.getProjectMemory(projectId);
  }

  appendProjectMemoryEntry(projectId: string, entryMarkdown: string, updatedAt = new Date().toISOString()): ProjectMemory {
    const current = this.getProjectMemory(projectId).contentMarkdown.trim();
    const next = [current, entryMarkdown.trim()].filter(Boolean).join("\n\n");
    return this.updateProjectMemory(projectId, next.slice(0, 40_000), updatedAt);
  }

  private listUsageEventsForProject(projectId: string): AgentEventEnvelope[] {
    const rows = this.database
      .prepare(`
        SELECT *
        FROM events
        WHERE project_id = ?
          AND type IN ('usage_updated', 'context_updated')
        ORDER BY occurred_at, sequence
      `)
      .all(projectId) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  createExecutionAttempt(input: {
    id: string;
    taskId: string;
    attemptNumber: number;
    status: AttemptStatus;
    startedAt: string;
  }): ExecutionAttempt {
    const status = parseAttemptStatus(input.status);
    try {
      this.database
        .prepare(`
          INSERT INTO execution_attempts(id, task_id, attempt_number, status, started_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(input.id, input.taskId, input.attemptNumber, status, input.startedAt);
    } catch (error) {
      if (isConstraintError(error)) throw new AgentJournalConflictError();
      throw error;
    }
    return this.getExecutionAttempt(input.id);
  }

  nextExecutionAttemptNumber(taskId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number FROM execution_attempts WHERE task_id = ?")
      .get(taskId) as { attempt_number: number };
    return row.attempt_number;
  }

  getExecutionAttempt(id: string): ExecutionAttempt {
    const row = this.database.prepare("SELECT * FROM execution_attempts WHERE id = ?").get(id) as
      | AttemptRow
      | undefined;
    if (!row) throw new AgentJournalConflictError("Execution attempt not found.");
    return toAttempt(row);
  }

  updateExecutionAttemptStatus(
    id: string,
    statusInput: AttemptStatus,
    timestamp = new Date().toISOString(),
    outcomeSummary?: string,
  ): ExecutionAttempt {
    const status = parseAttemptStatus(statusInput);
    this.database
      .prepare(`
        UPDATE execution_attempts
        SET status = ?,
            ended_at = CASE WHEN ? IN ('DONE', 'FAILED', 'CANCELLED', 'INTERRUPTED') THEN ? ELSE ended_at END,
            outcome_summary = COALESCE(?, outcome_summary)
        WHERE id = ?
      `)
      .run(status, status, timestamp, outcomeSummary ?? null, id);
    return this.getExecutionAttempt(id);
  }

  createSession(input: {
    id: string;
    taskId: string;
    attemptId?: string;
    provider: ProviderId;
    providerSessionId?: string;
    type: AgentSession["type"];
    status: AgentSession["status"];
    createdAt: string;
  }): AgentSession {
    const type = parseSessionType(input.type);
    const status = parseSessionStatus(input.status);
    try {
      this.database
        .prepare(`
          INSERT INTO sessions(
            id, task_id, attempt_id, provider, provider_session_id, type, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.id,
          input.taskId,
          input.attemptId ?? null,
          input.provider,
          input.providerSessionId ?? null,
          type,
          status,
          input.createdAt,
        );
    } catch (error) {
      if (isConstraintError(error)) throw new AgentJournalConflictError();
      throw error;
    }
    return this.getSession(input.id);
  }

  getSession(id: string): AgentSession {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw new AgentJournalConflictError("Session not found.");
    return toSession(row);
  }

  getLatestSessionForTask(taskId: string, type?: AgentSession["type"]): AgentSession | null {
    const row = this.database
      .prepare(`
        SELECT *
        FROM sessions
        WHERE task_id = ?
          AND (? IS NULL OR type = ?)
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `)
      .get(taskId, type ?? null, type ?? null) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  updateSessionStatus(
    id: string,
    statusInput: AgentSession["status"],
    timestamp = new Date().toISOString(),
  ): AgentSession {
    const status = parseSessionStatus(statusInput);
    this.database
      .prepare("UPDATE sessions SET status = ?, ended_at = CASE WHEN ? = 'ENDED' THEN ? ELSE ended_at END WHERE id = ?")
      .run(status, status, timestamp, id);
    return this.getSession(id);
  }

  appendEvent(envelope: AgentEventEnvelope, createdAt = new Date().toISOString()): AgentEventEnvelope {
    const parsed = parseAgentEventEnvelope(envelope);
    try {
      this.database
        .prepare(`
          INSERT INTO events(
            id, project_id, task_id, session_id, sequence, schema_version, type,
            payload_json, persistence, occurred_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          parsed.eventId,
          parsed.projectId,
          parsed.taskId,
          parsed.sessionId,
          parsed.sequence,
          parsed.schemaVersion,
          parsed.payload.type,
          JSON.stringify(parsed.payload),
          parsed.persistence,
          parsed.occurredAt,
          createdAt,
        );
    } catch (error) {
      if (isConstraintError(error)) throw new AgentJournalConflictError();
      throw error;
    }
    return parsed;
  }

  listEventsForSession(sessionId: string): AgentEventEnvelope[] {
    const rows = this.database
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  listEventsForTask(taskId: string): AgentEventEnvelope[] {
    const rows = this.database
      .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY occurred_at, sequence")
      .all(taskId) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  countEventsForSession(sessionId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM events WHERE session_id = ?").get(sessionId) as {
      count: number;
    };
    return row.count;
  }

  countSessionsForTask(taskId: string, type?: AgentSession["type"]): number {
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM sessions
        WHERE task_id = ?
          AND (? IS NULL OR type = ?)
      `)
      .get(taskId, type ?? null, type ?? null) as { count: number };
    return row.count;
  }

  createTaskSpec(input: {
    id: string;
    taskId: string;
    contentMarkdown: string;
    sha256: string;
    sourceSessionId?: string;
    createdAt: string;
  }): TaskSpec {
    const version = this.nextSpecVersion(input.taskId);
    try {
      this.database
        .prepare(`
          INSERT INTO task_specs(id, task_id, version, content_markdown, sha256, source_session_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.id,
          input.taskId,
          version,
          input.contentMarkdown,
          input.sha256,
          input.sourceSessionId ?? null,
          input.createdAt,
        );
    } catch (error) {
      if (isConstraintError(error)) throw new AgentJournalConflictError();
      throw error;
    }
    const spec = this.getLatestSpec(input.taskId);
    if (!spec) throw new AgentJournalConflictError("Task spec not found.");
    return spec;
  }

  getLatestSpec(taskId: string): TaskSpec | null {
    const row = this.database
      .prepare("SELECT * FROM task_specs WHERE task_id = ? ORDER BY version DESC LIMIT 1")
      .get(taskId) as TaskSpecRow | undefined;
    return row ? toTaskSpec(row) : null;
  }

  createTaskPlan(input: {
    id: string;
    taskId: string;
    contentMarkdown: string;
    sha256: string;
    sourceSessionId?: string;
    createdAt: string;
  }): TaskPlan {
    const version = this.nextPlanVersion(input.taskId);
    try {
      this.database
        .prepare(`
          INSERT INTO task_plans(id, task_id, version, content_markdown, sha256, source_session_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.id,
          input.taskId,
          version,
          input.contentMarkdown,
          input.sha256,
          input.sourceSessionId ?? null,
          input.createdAt,
        );
    } catch (error) {
      if (isConstraintError(error)) throw new AgentJournalConflictError();
      throw error;
    }
    const plan = this.getLatestPlan(input.taskId);
    if (!plan) throw new AgentJournalConflictError("Task plan not found.");
    return plan;
  }

  getLatestPlan(taskId: string): TaskPlan | null {
    const row = this.database
      .prepare("SELECT * FROM task_plans WHERE task_id = ? ORDER BY version DESC LIMIT 1")
      .get(taskId) as TaskPlanRow | undefined;
    return row ? toTaskPlan(row) : null;
  }

  approveLatestSpec(taskId: string, approvedAt = new Date().toISOString()): TaskSpec {
    const spec = this.getLatestSpec(taskId);
    if (!spec) throw new AgentJournalConflictError("Task spec not found.");
    this.database.prepare("UPDATE task_specs SET approved_at = ? WHERE id = ?").run(approvedAt, spec.id);
    const approved = this.getLatestSpec(taskId);
    if (!approved) throw new AgentJournalConflictError("Task spec not found.");
    return approved;
  }

  private nextSpecVersion(taskId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM task_specs WHERE task_id = ?")
      .get(taskId) as { version: number };
    return row.version;
  }

  private nextPlanVersion(taskId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM task_plans WHERE task_id = ?")
      .get(taskId) as { version: number };
    return row.version;
  }
}
