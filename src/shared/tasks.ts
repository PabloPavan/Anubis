import type { ProviderId, WorkflowId } from "./projects";

export const taskStatuses = [
  "DRAFT",
  "BRAINSTORMING",
  "DESIGN_REVIEW",
  "QUEUED",
  "PLANNING",
  "EXECUTING",
  "VERIFYING",
  "EXECUTION_REVIEW",
  "WAITING_USER",
  "READY_TO_RESUME",
  "BLOCKED",
  "FAILED",
  "INTERRUPTED",
  "DONE",
  "CANCELLED",
] as const;

export const sessionTypes = ["BRAINSTORM", "EXECUTION"] as const;
export const sessionStatuses = ["ACTIVE", "SUSPENDED", "ENDED"] as const;
export const attemptStatuses = ["PLANNING", "EXECUTING", "VERIFYING", "DONE", "FAILED", "CANCELLED", "INTERRUPTED"] as const;

export const claudeModelOptions = ["default", "sonnet", "opus", "haiku"] as const;
export const geminiModelOptions = [
  "default",
  "gemini-3.8-pro",
  "gemini-3.8-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "pro",
  "flash",
  "flash-lite",
] as const;

export const agentModelOptions = [
  "default",
  "sonnet",
  "opus",
  "haiku",
  "gemini-3.8-pro",
  "gemini-3.8-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "pro",
  "flash",
  "flash-lite",
] as const;

export const claudeEffortOptions = ["default", "low", "medium", "high", "xhigh", "max"] as const;
export const geminiEffortOptions = ["default", "low", "medium", "high", "off"] as const;

export const agentEffortOptions = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "off",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type SessionType = (typeof sessionTypes)[number];
export type SessionStatus = (typeof sessionStatuses)[number];
export type AttemptStatus = (typeof attemptStatuses)[number];
export type AgentModelOption = (typeof agentModelOptions)[number];
export type AgentEffortOption = (typeof agentEffortOptions)[number];

export const providerModels: Record<ProviderId, readonly AgentModelOption[]> = {
  claude: ["default", "sonnet", "opus", "haiku"],
  gemini: [
    "default",
    "gemini-3.8-pro",
    "gemini-3.8-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
};

export const providerEfforts: Record<ProviderId, readonly AgentEffortOption[]> = {
  claude: ["default", "low", "medium", "high", "xhigh", "max"],
  gemini: ["default", "low", "medium", "high", "off"],
};

export const agentModelLabels: Record<AgentModelOption, string> = {
  default: "Default",
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
  "gemini-3.8-pro": "Gemini 3.8 Pro",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  "gemini-1.5-pro": "Gemini 1.5 Pro",
  "gemini-1.5-flash": "Gemini 1.5 Flash",
  pro: "Gemini Pro",
  flash: "Gemini Flash",
  "flash-lite": "Gemini Flash Lite",
};

export const agentEffortLabels: Record<AgentEffortOption, string> = {
  default: "Default",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  off: "Thinking Off",
};

export interface Task {
  id: string;
  projectId: string;
  taskNumber: number;
  title: string;
  description: string;
  status: TaskStatus;
  provider: ProviderId;
  workflow: WorkflowId;
  model: AgentModelOption;
  effort: AgentEffortOption;
  revision: number;
  autoResumeAt?: string;
  lastFailureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export function parseAgentModelOption(value: unknown): AgentModelOption {
  if (typeof value !== "string" || !agentModelOptions.includes(value as AgentModelOption)) {
    throw new TaskValidationError("Agent model is invalid.");
  }
  return value as AgentModelOption;
}

export function parseAgentEffortOption(value: unknown): AgentEffortOption {
  if (typeof value !== "string" || !agentEffortOptions.includes(value as AgentEffortOption)) {
    throw new TaskValidationError("Agent effort is invalid.");
  }
  return value as AgentEffortOption;
}

export interface ExecutionAttempt {
  id: string;
  taskId: string;
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: string;
  endedAt?: string;
  outcomeSummary?: string;
}

export interface AgentSession {
  id: string;
  taskId: string;
  attemptId?: string;
  provider: ProviderId;
  providerSessionId?: string;
  type: SessionType;
  status: SessionStatus;
  createdAt: string;
  suspendedAt?: string;
  endedAt?: string;
}

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

export function parseTaskStatus(value: unknown): TaskStatus {
  if (typeof value !== "string" || !taskStatuses.includes(value as TaskStatus)) {
    throw new TaskValidationError("Task status is invalid.");
  }
  return value as TaskStatus;
}

export function parseAttemptStatus(value: unknown): AttemptStatus {
  if (typeof value !== "string" || !attemptStatuses.includes(value as AttemptStatus)) {
    throw new TaskValidationError("Execution attempt status is invalid.");
  }
  return value as AttemptStatus;
}

export function parseSessionType(value: unknown): SessionType {
  if (typeof value !== "string" || !sessionTypes.includes(value as SessionType)) {
    throw new TaskValidationError("Session type is invalid.");
  }
  return value as SessionType;
}

export function parseSessionStatus(value: unknown): SessionStatus {
  if (typeof value !== "string" || !sessionStatuses.includes(value as SessionStatus)) {
    throw new TaskValidationError("Session status is invalid.");
  }
  return value as SessionStatus;
}
