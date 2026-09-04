import type { ProviderId, WorkflowId } from "./projects";
import type { AgentEvent, AgentEventEnvelope, AgentQuestion } from "./agent-events";
import type { SessionStatus, TaskStatus } from "./tasks";

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

export interface ExecutionResult {
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
  spec?: TaskSpec;
}

export interface ReviewDecisionInput {
  taskId: string;
  decision: "approve" | "changes";
}

export interface BrainstormRevisionInput {
  taskId: string;
  feedback: string;
}

export interface QuestionAnswerInput {
  taskId: string;
  questionId: string;
  answer: string;
}

export interface TaskSpec {
  id: string;
  taskId: string;
  version: number;
  contentMarkdown: string;
  sha256: string;
  sourceSessionId?: string;
  approvedAt?: string;
  createdAt: string;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  taskNumber: number;
  title: string;
  status: TaskStatus;
  updatedAt: string;
  latestActivityAt: string;
  latestEventType?: AgentEvent["type"];
  latestEventText?: string;
  latestSessionId?: string;
  latestProviderSessionId?: string;
  latestSessionStatus?: SessionStatus;
  latestSpecVersion?: number;
  latestSpecApprovedAt?: string;
  pendingQuestions: AgentQuestion[];
  eventCount: number;
}

export interface AppApi {
  getHealth(): Promise<AppHealth>;
  runClaudeDemo(projectId: string): Promise<ClaudeDemoResult>;
  listSessionEvents(sessionId: string): Promise<AgentEventEnvelope[]>;
  startBrainstorm(input: BrainstormDraft): Promise<BrainstormResult>;
  reviseBrainstorm(input: BrainstormRevisionInput): Promise<BrainstormResult>;
  answerQuestion(input: QuestionAnswerInput): Promise<BrainstormResult>;
  startTaskExecution(taskId: string): Promise<ExecutionResult>;
  listTasks(projectId: string): Promise<TaskSummary[]>;
  getLatestSpec(taskId: string): Promise<TaskSpec | null>;
  reviewTask(input: ReviewDecisionInput): Promise<TaskSummary>;
}
