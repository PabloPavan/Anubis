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
