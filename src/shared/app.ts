import type { ProviderId, WorkflowId } from "./projects";
import type { AgentContextUsage, AgentEvent, AgentEventEnvelope, AgentQuestion } from "./agent-events";
import type { AgentEffortOption, AgentModelOption, SessionStatus, SessionType, TaskStatus } from "./tasks";

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
  providers: ProviderHealth[];
  workflows: WorkflowHealth[];
}

export interface ExecutionResult {
  taskId: string;
  attemptId: string;
  sessionId: string;
  providerSessionId: string;
  eventCount: number;
  summary: string;
}

export const conversationImageMediaTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type ConversationImageMediaType = (typeof conversationImageMediaTypes)[number];

export interface ConversationImageAttachment {
  name: string;
  mediaType: ConversationImageMediaType;
  dataBase64: string;
  sizeBytes: number;
}

export interface BrainstormDraft {
  projectId: string;
  title: string;
  description: string;
  model?: AgentModelOption;
  effort?: AgentEffortOption;
  includeProjectMemory?: boolean;
  contextTaskIds?: string[];
  images?: ConversationImageAttachment[];
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

export interface ExecutionReviewDecisionInput {
  taskId: string;
  decision: "complete" | "changes";
  feedback?: string;
  memoryUpdate?: string;
}

export interface BrainstormRevisionInput {
  taskId: string;
  feedback: string;
  images?: ConversationImageAttachment[];
}

export interface QuestionAnswerInput {
  taskId: string;
  questionId?: string;
  answer?: string;
  answers?: Array<{ questionId: string; answer: string }>;
  images?: ConversationImageAttachment[];
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
  description: string;
  status: TaskStatus;
  model: AgentModelOption;
  effort: AgentEffortOption;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  completedDurationSeconds?: number;
  latestActivityAt: string;
  latestEventType?: AgentEvent["type"];
  latestEventText?: string;
  latestSessionId?: string;
  latestProviderSessionId?: string;
  latestSessionType?: SessionType;
  latestSessionStatus?: SessionStatus;
  latestSpecVersion?: number;
  latestSpecApprovedAt?: string;
  autoResumeAt?: string;
  lastFailureCode?: string;
  contextTaskIds: string[];
  pendingQuestions: AgentQuestion[];
  eventCount: number;
}

export interface ProjectMemory {
  projectId: string;
  contentMarkdown: string;
  updatedAt: string;
}

export interface ProjectMemoryUpdateInput {
  projectId: string;
  contentMarkdown: string;
}

export interface AgentUsageSummary {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  sessions: number;
  latestContext?: AgentContextUsage;
  byModel: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      thinkingTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      webSearchRequests: number;
      costUsd: number;
    }
  >;
}

export interface ProjectStats {
  projectId: string;
  totalTasks: number;
  draftTasks: number;
  attentionTasks: number;
  queuedTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  eventCount: number;
  specCount: number;
  completionRate: number;
  totalCompletedDurationSeconds: number;
  averageCompletedDurationSeconds: number;
  costPerCompletedHourUsd: number;
  usage: AgentUsageSummary;
  latestActivityAt?: string;
  byStatus: Record<TaskStatus, number>;
}

export interface NotificationSettings {
  desktopEnabled: boolean;
  desktopSound: boolean;
  brainstormNeedsAnswer: boolean;
  brainstormReadyForReview: boolean;
  brainstormFailed: boolean;
  executionCompleted: boolean;
  executionFailed: boolean;
  autoResumeAfterLimit: boolean;
  controlledMaxTurns: boolean;
}

export type DesktopNotificationTestKind = Exclude<
  keyof NotificationSettings,
  "desktopEnabled" | "desktopSound" | "autoResumeAfterLimit" | "controlledMaxTurns"
>;

export interface AppApi {
  getHealth(): Promise<AppHealth>;
  getNotificationSettings(): Promise<NotificationSettings>;
  updateNotificationSettings(input: NotificationSettings): Promise<NotificationSettings>;
  testDesktopNotification(kind: DesktopNotificationTestKind): Promise<void>;
  listSessionEvents(sessionId: string): Promise<AgentEventEnvelope[]>;
  listTaskEvents(taskId: string): Promise<AgentEventEnvelope[]>;
  createTaskDraft(input: BrainstormDraft): Promise<TaskSummary>;
  updateTaskDraft(taskId: string, input: BrainstormDraft): Promise<TaskSummary>;
  startBrainstorm(input: BrainstormDraft): Promise<BrainstormResult>;
  reviseBrainstorm(input: BrainstormRevisionInput): Promise<BrainstormResult>;
  retryBrainstorm(taskId: string): Promise<BrainstormResult>;
  answerQuestion(input: QuestionAnswerInput): Promise<BrainstormResult>;
  startTaskExecution(taskId: string): Promise<ExecutionResult>;
  listTasks(projectId: string, limit?: number | null): Promise<TaskSummary[]>;
  getProjectMemory(projectId: string): Promise<ProjectMemory>;
  updateProjectMemory(input: ProjectMemoryUpdateInput): Promise<ProjectMemory>;
  getProjectStats(projectId: string): Promise<ProjectStats>;
  getLatestSpec(taskId: string): Promise<TaskSpec | null>;
  reviewTask(input: ReviewDecisionInput): Promise<TaskSummary>;
  reviewExecution(input: ExecutionReviewDecisionInput): Promise<TaskSummary>;
}
