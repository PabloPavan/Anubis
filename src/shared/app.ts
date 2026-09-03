import type { ProviderId, WorkflowId } from "./projects";
import type { AgentEventEnvelope } from "./agent-events";
import type { TaskStatus } from "./tasks";

export interface AgentCapabilities {
  streaming: boolean;
  cancellation: boolean;
  resume: boolean;
  structuredQuestions: boolean;
  subagentEvents: boolean;
}

export interface ProviderHealth {
  id: ProviderId;
  displayName: string;
  configured: boolean;
  available: boolean;
  capabilities: AgentCapabilities;
  message?: string;
}

export interface WorkflowHealth {
  id: WorkflowId;
  displayName: string;
  configured: boolean;
  available: boolean;
  message?: string;
}

export interface AppHealth {
  phase: "phase-2-foundation";
  providers: ProviderHealth[];
  workflows: WorkflowHealth[];
}

export interface ClaudeDemoResult {
  taskId: string;
  attemptId: string;
  sessionId: string;
  providerSessionId: string;
  eventCount: number;
  summary: string;
}

export interface BrainstormDraft {
  projectId: string;
  title: string;
  description: string;
}

export interface BrainstormResult {
  taskId: string;
  sessionId: string;
  providerSessionId: string;
  eventCount: number;
  summary: string;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  taskNumber: number;
  title: string;
  status: TaskStatus;
  updatedAt: string;
  latestSessionId?: string;
  latestProviderSessionId?: string;
  eventCount: number;
}

export interface AppApi {
  getHealth(): Promise<AppHealth>;
  runClaudeDemo(projectId: string): Promise<ClaudeDemoResult>;
  listSessionEvents(sessionId: string): Promise<AgentEventEnvelope[]>;
  startBrainstorm(input: BrainstormDraft): Promise<BrainstormResult>;
  listTasks(projectId: string): Promise<TaskSummary[]>;
}
