import type { DatabaseSync } from "node:sqlite";
import {
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

  getExecutionAttempt(id: string): ExecutionAttempt {
    const row = this.database.prepare("SELECT * FROM execution_attempts WHERE id = ?").get(id) as
      | AttemptRow
      | undefined;
    if (!row) throw new AgentJournalConflictError("Execution attempt not found.");
    return toAttempt(row);
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

  countEventsForSession(sessionId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM events WHERE session_id = ?").get(sessionId) as {
      count: number;
    };
    return row.count;
  }
}
