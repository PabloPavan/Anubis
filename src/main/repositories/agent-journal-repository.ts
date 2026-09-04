import type { DatabaseSync } from "node:sqlite";
import {
  type AgentEvent,
  parseAgentEventEnvelope,
  type AgentEventEnvelope,
} from "../../shared/agent-events";
import {
  parseAttemptStatus,
  parseSessionStatus,
  parseSessionType,
  parseTaskStatus,
  type AgentSession,
  type AttemptStatus,
  type ExecutionAttempt,
  type Task,
  type TaskStatus,
} from "../../shared/tasks";
import type { ProviderId, WorkflowId } from "../../shared/projects";
import type { TaskSpec, TaskSummary } from "../../shared/app";

interface TaskRow {
  id: string;
  project_id: string;
  task_number: number;
  title: string;
  description: string;
  status: TaskStatus;
  provider: ProviderId;
  workflow: WorkflowId;
  revision: number;
  created_at: string;
  updated_at: string;
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
  status: TaskStatus;
  updated_at: string;
  latest_activity_at: string;
  latest_event_type: AgentEvent["type"] | null;
  latest_event_payload_json: string | null;
  latest_session_id: string | null;
  latest_provider_session_id: string | null;
  latest_session_status: AgentSession["status"] | null;
  latest_spec_version: number | null;
  latest_spec_approved_at: string | null;
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
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    status: row.status,
    updatedAt: row.updated_at,
    latestActivityAt: row.latest_activity_at,
    ...(latestEvent.type ? { latestEventType: latestEvent.type } : {}),
    ...(latestEvent.text ? { latestEventText: latestEvent.text } : {}),
    ...(row.latest_session_id ? { latestSessionId: row.latest_session_id } : {}),
    ...(row.latest_provider_session_id ? { latestProviderSessionId: row.latest_provider_session_id } : {}),
    ...(row.latest_session_status ? { latestSessionStatus: row.latest_session_status } : {}),
    ...(row.latest_spec_version ? { latestSpecVersion: row.latest_spec_version } : {}),
    ...(row.latest_spec_approved_at ? { latestSpecApprovedAt: row.latest_spec_approved_at } : {}),
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
    position: number;
    now: string;
  }): Task {
    const status = parseTaskStatus(input.status);
    try {
      this.database
        .prepare(`
          INSERT INTO tasks(
            id, project_id, task_number, title, description, status, provider, workflow,
            position, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  listTasksForProject(projectId: string, limit: number | null = 20): TaskSummary[] {
    const limitClause = limit === null ? "" : "LIMIT ?";
    const rows = this.database
      .prepare(`
        SELECT
          tasks.id,
          tasks.project_id,
          tasks.task_number,
          tasks.title,
          tasks.status,
          tasks.updated_at,
          COALESCE(
            (
              SELECT MAX(task_events.occurred_at)
              FROM events AS task_events
              WHERE task_events.task_id = tasks.id
            ),
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
          COUNT(events.id) AS event_count
        FROM tasks
        LEFT JOIN sessions AS latest_session
          ON latest_session.id = (
            SELECT sessions.id
            FROM sessions
            WHERE sessions.task_id = tasks.id
            ORDER BY sessions.created_at DESC
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
        WHERE tasks.project_id = ?
        GROUP BY tasks.id
        ORDER BY latest_activity_at DESC, tasks.updated_at DESC, tasks.task_number DESC
        ${limitClause}
      `)
      .all(...(limit === null ? [projectId] : [projectId, limit])) as unknown as TaskSummaryRow[];
    return rows.map(toTaskSummary);
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
        ORDER BY created_at DESC
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
}
