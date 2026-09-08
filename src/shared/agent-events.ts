export const workflowStages = ["BRAINSTORMING", "PLANNING", "EXECUTING", "VERIFYING"] as const;
export const eventPersistenceModes = ["EPHEMERAL", "DURABLE"] as const;
export const failureClasses = ["AUTH", "RATE_LIMIT", "PROVIDER", "WORKFLOW", "CANCELLED", "UNKNOWN"] as const;

export type WorkflowStage = (typeof workflowStages)[number];
export type EventPersistence = (typeof eventPersistenceModes)[number];
export type FailureClass = (typeof failureClasses)[number];

export interface SafeError {
  message: string;
  code?: string;
}

export interface AgentQuestion {
  id: string;
  prompt: string;
  context?: string;
  options?: string[];
}

export interface PlanItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
}

export type AgentEvent =
  | { type: "message_delta"; messageId: string; text: string }
  | { type: "message_completed"; messageId: string; text?: string }
  | { type: "thinking_status"; text?: string }
  | { type: "stage_changed"; stage: WorkflowStage }
  | { type: "tool_started"; callId: string; tool: string; detail?: string }
  | { type: "tool_finished"; callId: string; tool: string; detail?: string }
  | { type: "tool_failed"; callId: string; tool: string; error: SafeError }
  | { type: "file_changed"; path: string; change?: "created" | "modified" | "deleted" }
  | { type: "command_started"; callId: string; command: string }
  | { type: "command_finished"; callId: string; command: string; exitCode: number }
  | { type: "question_asked"; question: AgentQuestion }
  | { type: "question_answered"; questionId: string }
  | { type: "subagent_started"; subagentId: string; name?: string; role?: string }
  | { type: "subagent_finished"; subagentId: string; name?: string; outcome?: string }
  | { type: "plan_updated"; revision: number; items: PlanItem[] }
  | { type: "verification_result"; passed: boolean; summary: string }
  | { type: "rate_limit_updated"; status: "allowed" | "allowed_warning" | "rejected"; rateLimitType?: string; resetsAt?: string }
  | { type: "session_started" }
  | { type: "session_suspended"; reason: "WAITING_USER" | "INTERRUPTED" }
  | { type: "session_resumed" }
  | { type: "session_finished"; outcome: "COMPLETED" | "CANCELLED" | "FAILED" }
  | { type: "completed"; summary?: string }
  | { type: "failed"; error: SafeError; classification: FailureClass };

export interface AgentEventEnvelope<T extends AgentEvent = AgentEvent> {
  eventId: string;
  schemaVersion: 1;
  occurredAt: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  sequence: number;
  persistence: EventPersistence;
  payload: T;
}

export class AgentEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEventValidationError";
  }
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentEventValidationError(`${field} must be an object.`);
  }
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new AgentEventValidationError(`${field} must be text.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new AgentEventValidationError(`${field} must contain between 1 and ${maximum} characters.`);
  }
  if (normalized.includes("\0")) {
    throw new AgentEventValidationError(`${field} contains an invalid character.`);
  }
  return normalized;
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maximum);
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AgentEventValidationError(`${field} must be a non-negative integer.`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new AgentEventValidationError(`${field} must be a boolean.`);
  }
  return value;
}

function requiredIsoDate(value: unknown, field: string): string {
  const text = requiredString(value, field, 64);
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) {
    throw new AgentEventValidationError(`${field} must be a UTC ISO-8601 timestamp.`);
  }
  return text;
}

function parseSafeError(value: unknown): SafeError {
  assertRecord(value, "Error");
  const code = optionalString(value.code, "Error code", 64);
  return {
    message: requiredString(value.message, "Error message", 2_000),
    ...(code ? { code } : {}),
  };
}

function parseQuestion(value: unknown): AgentQuestion {
  assertRecord(value, "Question");
  const context = optionalString(value.context, "Question context", 4_000);
  const rawOptions = value.options;
  let options: string[] | undefined;
  if (rawOptions !== undefined) {
    if (!Array.isArray(rawOptions) || rawOptions.length > 20) {
      throw new AgentEventValidationError("Question options must be a short list.");
    }
    options = rawOptions.map((option, index) => requiredString(option, `Question option ${index + 1}`, 500));
  }
  return {
    id: requiredString(value.id, "Question ID", 128),
    prompt: requiredString(value.prompt, "Question prompt", 4_000),
    ...(context ? { context } : {}),
    ...(options ? { options } : {}),
  };
}

function parsePlanItems(value: unknown): PlanItem[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new AgentEventValidationError("Plan items must be a bounded list.");
  }
  return value.map((item, index) => {
    assertRecord(item, `Plan item ${index + 1}`);
    const status = requiredString(item.status, `Plan item ${index + 1} status`, 32);
    if (!["pending", "in_progress", "completed", "blocked"].includes(status)) {
      throw new AgentEventValidationError(`Plan item ${index + 1} status is invalid.`);
    }
    return {
      id: requiredString(item.id, `Plan item ${index + 1} ID`, 128),
      title: requiredString(item.title, `Plan item ${index + 1} title`, 500),
      status: status as PlanItem["status"],
    };
  });
}

export function parseAgentEvent(value: unknown): AgentEvent {
  assertRecord(value, "Agent event");
  const type = requiredString(value.type, "Agent event type", 64);

  switch (type) {
    case "message_delta":
      return {
        type,
        messageId: requiredString(value.messageId, "Message ID", 128),
        text: requiredString(value.text, "Message text", 20_000),
      };
    case "message_completed": {
      const text = optionalString(value.text, "Message text", 100_000);
      return { type, messageId: requiredString(value.messageId, "Message ID", 128), ...(text ? { text } : {}) };
    }
    case "thinking_status": {
      const text = optionalString(value.text, "Thinking status", 2_000);
      return { type, ...(text ? { text } : {}) };
    }
    case "stage_changed": {
      const stage = requiredString(value.stage, "Workflow stage", 32);
      if (!workflowStages.includes(stage as WorkflowStage)) {
        throw new AgentEventValidationError("Workflow stage is invalid.");
      }
      return { type, stage: stage as WorkflowStage };
    }
    case "tool_started":
    case "tool_finished": {
      const detail = optionalString(value.detail, "Tool detail", 2_000);
      return {
        type,
        callId: requiredString(value.callId, "Tool call ID", 128),
        tool: requiredString(value.tool, "Tool name", 256),
        ...(detail ? { detail } : {}),
      };
    }
    case "tool_failed":
      return {
        type,
        callId: requiredString(value.callId, "Tool call ID", 128),
        tool: requiredString(value.tool, "Tool name", 256),
        error: parseSafeError(value.error),
      };
    case "file_changed": {
      const change = optionalString(value.change, "File change", 32);
      if (change && !["created", "modified", "deleted"].includes(change)) {
        throw new AgentEventValidationError("File change is invalid.");
      }
      return {
        type,
        path: requiredString(value.path, "File path", 32_767),
        ...(change ? { change: change as "created" | "modified" | "deleted" } : {}),
      };
    }
    case "command_started":
      return { type, callId: requiredString(value.callId, "Command call ID", 128), command: requiredString(value.command, "Command", 4_000) };
    case "command_finished":
      return {
        type,
        callId: requiredString(value.callId, "Command call ID", 128),
        command: requiredString(value.command, "Command", 4_000),
        exitCode: requiredNumber(value.exitCode, "Command exit code"),
      };
    case "question_asked":
      return { type, question: parseQuestion(value.question) };
    case "question_answered":
      return { type, questionId: requiredString(value.questionId, "Question ID", 128) };
    case "subagent_started": {
      const name = optionalString(value.name, "Subagent name", 256);
      const role = optionalString(value.role, "Subagent role", 256);
      return { type, subagentId: requiredString(value.subagentId, "Subagent ID", 128), ...(name ? { name } : {}), ...(role ? { role } : {}) };
    }
    case "subagent_finished": {
      const name = optionalString(value.name, "Subagent name", 256);
      const outcome = optionalString(value.outcome, "Subagent outcome", 2_000);
      return { type, subagentId: requiredString(value.subagentId, "Subagent ID", 128), ...(name ? { name } : {}), ...(outcome ? { outcome } : {}) };
    }
    case "plan_updated":
      return { type, revision: requiredNumber(value.revision, "Plan revision"), items: parsePlanItems(value.items) };
    case "verification_result":
      return {
        type,
        passed: requiredBoolean(value.passed, "Verification result"),
        summary: requiredString(value.summary, "Verification summary", 4_000),
      };
    case "rate_limit_updated": {
      const status = requiredString(value.status, "Rate limit status", 32);
      if (!["allowed", "allowed_warning", "rejected"].includes(status)) {
        throw new AgentEventValidationError("Rate limit status is invalid.");
      }
      const rateLimitType = optionalString(value.rateLimitType, "Rate limit type", 128);
      const resetsAt = value.resetsAt === undefined ? undefined : requiredIsoDate(value.resetsAt, "Rate limit reset");
      return {
        type,
        status: status as "allowed" | "allowed_warning" | "rejected",
        ...(rateLimitType ? { rateLimitType } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      };
    }
    case "session_started":
    case "session_resumed":
      return { type };
    case "session_suspended": {
      const reason = requiredString(value.reason, "Suspension reason", 32);
      if (!["WAITING_USER", "INTERRUPTED"].includes(reason)) {
        throw new AgentEventValidationError("Suspension reason is invalid.");
      }
      return { type, reason: reason as "WAITING_USER" | "INTERRUPTED" };
    }
    case "session_finished": {
      const outcome = requiredString(value.outcome, "Session outcome", 32);
      if (!["COMPLETED", "CANCELLED", "FAILED"].includes(outcome)) {
        throw new AgentEventValidationError("Session outcome is invalid.");
      }
      return { type, outcome: outcome as "COMPLETED" | "CANCELLED" | "FAILED" };
    }
    case "completed": {
      const summary = optionalString(value.summary, "Completion summary", 4_000);
      return { type, ...(summary ? { summary } : {}) };
    }
    case "failed": {
      const classification = requiredString(value.classification, "Failure classification", 32);
      if (!failureClasses.includes(classification as FailureClass)) {
        throw new AgentEventValidationError("Failure classification is invalid.");
      }
      return { type, error: parseSafeError(value.error), classification: classification as FailureClass };
    }
    default:
      throw new AgentEventValidationError("Agent event type is unsupported.");
  }
}

export function parseAgentEventEnvelope(value: unknown): AgentEventEnvelope {
  assertRecord(value, "Agent event envelope");
  if (value.schemaVersion !== 1) {
    throw new AgentEventValidationError("Agent event schema version is unsupported.");
  }
  const persistence = requiredString(value.persistence, "Event persistence", 32);
  if (!eventPersistenceModes.includes(persistence as EventPersistence)) {
    throw new AgentEventValidationError("Event persistence is invalid.");
  }

  return {
    eventId: requiredString(value.eventId, "Event ID", 128),
    schemaVersion: 1,
    occurredAt: requiredIsoDate(value.occurredAt, "Occurred at"),
    projectId: requiredString(value.projectId, "Project ID", 128),
    taskId: requiredString(value.taskId, "Task ID", 128),
    sessionId: requiredString(value.sessionId, "Session ID", 128),
    sequence: requiredNumber(value.sequence, "Event sequence"),
    persistence: persistence as EventPersistence,
    payload: parseAgentEvent(value.payload),
  };
}
