import { FormEvent, useCallback, useEffect, useState } from "react";
import type { AgentEventEnvelope } from "../../shared/agent-events";
import { conversationImageMediaTypes } from "../../shared/app";
import type {
  BrainstormResult,
  ConversationImageAttachment,
  DesktopNotificationTestKind,
  ExecutionResult,
  ExecutionReviewDecisionInput,
  AgentUsageSummary,
  NotificationSettings,
  ProjectStats,
  TaskSpec,
  TaskSummary,
} from "../../shared/app";
import type { Project, ProjectDraft } from "../../shared/projects";
import { agentEffortOptions, agentModelOptions } from "../../shared/tasks";
import type { AgentEffortOption, AgentModelOption, TaskStatus } from "../../shared/tasks";

const emptyDraft: ProjectDraft = {
  name: "",
  path: "",
  provider: "claude",
  workflow: "superpowers",
};

type AppView = "projects" | "attention" | "board" | "history" | "settings";
type EventTab = "summary" | "conversation" | "technical";

interface ReviewTask {
  project: Project;
  task: TaskSummary;
}

const maxAttachedImages = 5;
const maxAttachedImageBytes = 5 * 1024 * 1024;

const agentModelLabels: Record<AgentModelOption, string> = {
  default: "Default",
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
};

const agentEffortLabels: Record<AgentEffortOption, string> = {
  default: "Default",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function imageSizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function readImageAttachment(file: File): Promise<ConversationImageAttachment> {
  return new Promise((resolve, reject) => {
    if (!conversationImageMediaTypes.includes(file.type as ConversationImageAttachment["mediaType"])) {
      reject(new Error(`${file.name} is not a supported image type.`));
      return;
    }
    if (file.size > maxAttachedImageBytes) {
      reject(new Error(`${file.name} is larger than 5 MB.`));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`Could not read ${file.name}.`));
        return;
      }
      const [, dataBase64] = reader.result.split(",");
      if (!dataBase64) {
        reject(new Error(`${file.name} did not produce image data.`));
        return;
      }
      resolve({
        name: file.name,
        mediaType: file.type as ConversationImageAttachment["mediaType"],
        dataBase64,
        sizeBytes: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

interface BoardColumn {
  id: string;
  title: string;
  statuses: TaskStatus[];
}

type EventFilter = "all" | "messages" | "tools" | "errors" | "questions" | "usage" | "rate_limit";

const boardColumns: BoardColumn[] = [
  { id: "draft", title: "Draft", statuses: ["DRAFT"] },
  { id: "brainstorm", title: "Brainstorm", statuses: ["BRAINSTORMING"] },
  { id: "needs-input", title: "Needs input", statuses: ["WAITING_USER", "DESIGN_REVIEW", "EXECUTION_REVIEW"] },
  { id: "queued", title: "Queued", statuses: ["QUEUED", "READY_TO_RESUME"] },
  { id: "running", title: "Running", statuses: ["PLANNING", "EXECUTING", "VERIFYING"] },
  { id: "done", title: "Done", statuses: ["DONE"] },
  { id: "stopped", title: "Stopped", statuses: ["BLOCKED", "FAILED", "INTERRUPTED", "CANCELLED"] },
];

const eventFilters: Array<{ id: EventFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "messages", label: "Messages" },
  { id: "tools", label: "Tools" },
  { id: "errors", label: "Errors" },
  { id: "questions", label: "Questions" },
  { id: "usage", label: "Usage" },
  { id: "rate_limit", label: "Limits" },
];

const statusLabels: Record<TaskStatus, string> = {
  DRAFT: "Draft",
  BRAINSTORMING: "Brainstorming",
  WAITING_USER: "Needs answer",
  DESIGN_REVIEW: "Review spec",
  QUEUED: "Queued",
  READY_TO_RESUME: "Ready to resume",
  PLANNING: "Planning",
  EXECUTING: "Executing",
  VERIFYING: "Verifying",
  EXECUTION_REVIEW: "Review result",
  DONE: "Done",
  BLOCKED: "Blocked",
  FAILED: "Failed",
  INTERRUPTED: "Interrupted",
  CANCELLED: "Cancelled",
};

function statusTone(status: TaskStatus): "neutral" | "warn" | "info" | "active" | "success" | "danger" {
  if (status === "WAITING_USER" || status === "READY_TO_RESUME" || status === "EXECUTION_REVIEW") return "warn";
  if (status === "DESIGN_REVIEW" || status === "QUEUED") return "info";
  if (["BRAINSTORMING", "PLANNING", "EXECUTING", "VERIFYING"].includes(status)) return "active";
  if (status === "DONE") return "success";
  if (["FAILED", "BLOCKED", "INTERRUPTED", "CANCELLED"].includes(status)) return "danger";
  return "neutral";
}

function StatusBadge({ status }: { status: TaskStatus }): React.JSX.Element {
  return <span className="status-badge" data-tone={statusTone(status)}>{statusLabels[status]}</span>;
}

function canRunTask(task: TaskSummary): boolean {
  return task.status === "QUEUED" || (task.status === "READY_TO_RESUME" && task.latestSessionType !== "BRAINSTORM");
}

function canRetryBrainstorm(task: TaskSummary): boolean {
  return task.status === "DRAFT" ||
    (task.status === "FAILED" && Boolean(task.latestProviderSessionId) && task.latestSessionType !== "EXECUTION") ||
    (task.status === "READY_TO_RESUME" && task.latestSessionType === "BRAINSTORM");
}

function brainstormActionLabel(task: TaskSummary, activeTaskId: string | null): string {
  if (activeTaskId === task.id) return task.status === "DRAFT" ? "Starting..." : "Retrying...";
  if (task.status === "READY_TO_RESUME") return "Resume brainstorm";
  return task.status === "DRAFT" ? "Start brainstorm" : "Retry";
}

function taskRunLabel(task: TaskSummary, executingTaskId: string | null): string {
  if (executingTaskId === task.id) return task.status === "READY_TO_RESUME" ? "Resuming..." : "Running...";
  return task.status === "READY_TO_RESUME" ? "Resume" : "Run";
}

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
    case "user_message":
      return event.payload.text;
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
    case "rate_limit_updated":
      return [
        event.payload.status,
        event.payload.rateLimitType,
        event.payload.utilization !== undefined ? `${event.payload.utilization}% used` : "",
        event.payload.resetsAt ? `resets ${activityTime(event.payload.resetsAt)}` : "",
      ].filter(Boolean).join(" - ");
    case "usage_updated":
      return `${formatUsd(event.payload.usage.totalCostUsd)} - ${formatCompactNumber(totalUsageTokens(event.payload.usage))} tokens`;
    case "context_updated":
      return `${event.payload.context.percentage}% context - ${formatCompactNumber(event.payload.context.totalTokens)} / ${formatCompactNumber(event.payload.context.maxTokens)}`;
    case "execution_reviewed":
      return event.payload.feedback ?? event.payload.decision;
    case "tool_started":
    case "tool_finished":
    case "tool_failed":
      return event.payload.tool;
    case "subagent_started":
      return event.payload.description ?? event.payload.name ?? event.payload.role ?? event.payload.subagentId;
    case "subagent_finished":
      return event.payload.outcome ?? event.payload.name ?? event.payload.subagentId;
    default:
      return "";
  }
}

function eventBody(event: AgentEventEnvelope): string {
  const detail = eventDetail(event);
  return detail || JSON.stringify(event.payload, null, 2);
}

function eventMatchesFilter(event: AgentEventEnvelope, filter: EventFilter): boolean {
  if (filter === "all") return true;
  if (filter === "messages") {
    return ["user_message", "message_completed", "completed", "thinking_status"].includes(event.payload.type);
  }
  if (filter === "tools") return event.payload.type.startsWith("tool_");
  if (filter === "errors") {
    return event.payload.type === "failed" || event.payload.type === "tool_failed" ||
      (event.payload.type === "session_finished" && event.payload.outcome !== "COMPLETED");
  }
  if (filter === "questions") {
    return event.payload.type === "question_asked" ||
      event.payload.type === "question_answered" ||
      (event.payload.type === "user_message" && event.payload.kind === "question_answer");
  }
  if (filter === "usage") return event.payload.type === "usage_updated" || event.payload.type === "context_updated";
  return event.payload.type === "rate_limit_updated";
}

function eventMatchesSearch(event: AgentEventEnvelope, search: string): boolean {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return true;
  return [
    event.payload.type,
    event.eventId,
    event.sessionId,
    eventBody(event),
    JSON.stringify(event.payload),
  ].some((value) => value.toLowerCase().includes(normalized));
}

function eventDuration(events: AgentEventEnvelope[]): string {
  if (events.length < 2) return "0s";
  const times = events.map((event) => Date.parse(event.occurredAt)).filter((time) => !Number.isNaN(time));
  if (times.length < 2) return "0s";
  const seconds = Math.max(0, Math.round((Math.max(...times) - Math.min(...times)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function actionBanner(task: TaskSummary | undefined): { tone: "warn" | "info" | "danger" | "success"; title: string; detail: string } | null {
  if (!task) return null;
  if (task.status === "WAITING_USER") {
    return {
      tone: "warn",
      title: "Answer needed",
      detail: `${task.pendingQuestions.length} pending ${task.pendingQuestions.length === 1 ? "question" : "questions"}.`,
    };
  }
  if (task.status === "DESIGN_REVIEW") {
    return { tone: "info", title: "Spec ready for review", detail: "Approve it to queue execution or request changes." };
  }
  if (task.status === "READY_TO_RESUME") {
    return {
      tone: "warn",
      title: "Resume available",
      detail: task.lastFailureCode === "max_turns"
        ? "Claude reached the configured turn limit. Resume continues from the same session."
        : task.autoResumeAt
          ? `Scheduled after ${activityDateTime(task.autoResumeAt)}.`
          : "Resume manually when ready.",
    };
  }
  if (task.status === "EXECUTION_REVIEW") {
    return { tone: "warn", title: "Review execution result", detail: "Mark it done or send more instructions before closing the task." };
  }
  if (["FAILED", "BLOCKED", "INTERRUPTED", "CANCELLED"].includes(task.status)) {
    return { tone: "danger", title: "Task stopped", detail: `Current status is ${task.status}.` };
  }
  if (task.status === "DONE") return { tone: "success", title: "Task completed", detail: "Execution finished successfully." };
  return null;
}

function taskAction(task: TaskSummary): { label: string; detail: string; tone: "neutral" | "warn" | "info" | "active" | "success" | "danger" } {
  if (task.status === "WAITING_USER" && task.pendingQuestions.length > 0) {
    return {
      label: "Answer question",
      detail: `${task.pendingQuestions.length} pending ${task.pendingQuestions.length === 1 ? "question" : "questions"}`,
      tone: "warn",
    };
  }
  if (task.status === "DESIGN_REVIEW") return { label: "Review spec", detail: "Approve or request changes", tone: "info" };
  if (task.status === "READY_TO_RESUME") {
    return {
      label: task.latestSessionType === "BRAINSTORM" ? "Resume brainstorm" : "Resume task",
      detail: task.lastFailureCode === "max_turns"
        ? "Turn limit reached"
        : task.autoResumeAt
          ? `Available after ${activityTime(task.autoResumeAt)}`
          : "Ready when you are",
      tone: "warn",
    };
  }
  if (task.status === "EXECUTION_REVIEW") {
    return { label: "Review result", detail: "Approve completion or request changes", tone: "warn" };
  }
  if (task.status === "QUEUED") return { label: "Waiting in queue", detail: "Execution can start", tone: "info" };
  if (["BRAINSTORMING", "PLANNING", "EXECUTING", "VERIFYING"].includes(task.status)) {
    return { label: "Claude working", detail: statusLabels[task.status], tone: "active" };
  }
  if (task.status === "DONE") return { label: "Completed", detail: "No action needed", tone: "success" };
  if (["FAILED", "BLOCKED", "INTERRUPTED", "CANCELLED"].includes(task.status)) {
    return { label: "Needs inspection", detail: statusLabels[task.status], tone: "danger" };
  }
  return { label: "Draft", detail: "Brainstorm not finished", tone: "neutral" };
}

function needsAttention(task: TaskSummary): boolean {
  return ["WAITING_USER", "DESIGN_REVIEW", "EXECUTION_REVIEW", "READY_TO_RESUME", "FAILED", "BLOCKED", "INTERRUPTED"].includes(task.status);
}

function projectNextAction(tasks: TaskSummary[]): { label: string; detail: string; tone: "neutral" | "warn" | "info" | "active" | "success" | "danger" } {
  const sorted = [...tasks].sort((left, right) => Date.parse(right.latestActivityAt) - Date.parse(left.latestActivityAt));
  const actionable = sorted.find(needsAttention) ?? sorted.find((task) => task.status === "QUEUED") ?? sorted[0];
  if (!actionable) return { label: "Ready for work", detail: "No tasks created yet", tone: "neutral" };
  const action = taskAction(actionable);
  return { ...action, detail: `#${actionable.taskNumber} ${actionable.title} - ${action.detail}` };
}

function taskAgentLabel(task: Partial<Pick<TaskSummary, "model" | "effort">>): string {
  const modelKey = task.model && task.model in agentModelLabels ? task.model : "default";
  const effortKey = task.effort && task.effort in agentEffortLabels ? task.effort : "default";
  const model = agentModelLabels[modelKey];
  const effort = agentEffortLabels[effortKey];
  if (modelKey === "default" && effortKey === "default") return "Default model";
  return `${model} / ${effort}`;
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

function addUsageModel(
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
  const latestUsageBySession = new Map<string, Extract<AgentEventEnvelope["payload"], { type: "usage_updated" }>["usage"]>();
  let latestContext: Extract<AgentEventEnvelope["payload"], { type: "context_updated" }>["context"] | undefined;
  for (const event of events) {
    if (event.payload.type === "usage_updated") latestUsageBySession.set(event.sessionId, event.payload.usage);
    if (event.payload.type === "context_updated") latestContext = event.payload.context;
  }
  for (const snapshot of latestUsageBySession.values()) {
    usage.totalCostUsd += snapshot.totalCostUsd;
    usage.inputTokens += snapshot.inputTokens;
    usage.outputTokens += snapshot.outputTokens;
    usage.thinkingTokens += snapshot.thinkingTokens;
    usage.cacheReadInputTokens += snapshot.cacheReadInputTokens;
    usage.cacheCreationInputTokens += snapshot.cacheCreationInputTokens;
    usage.webSearchRequests += snapshot.webSearchRequests;
    usage.sessions += 1;
    for (const [model, modelUsage] of Object.entries(snapshot.modelUsage)) {
      addUsageModel(usage, model, {
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
  if (latestContext) usage.latestContext = latestContext;
  return usage;
}

function totalUsageTokens(usage: Pick<AgentUsageSummary, "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens">): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatUsdPerHour(value: number): string {
  if (value === 0) return "$0/h";
  if (value < 0.01) return `$${value.toFixed(4)}/h`;
  return `$${value.toFixed(2)}/h`;
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function eventTime(event: AgentEventEnvelope): string {
  return formatDateTime(event.occurredAt);
}

function activityTime(value: string): string {
  return formatDateTime(value);
}

function activityDateTime(value: string): string {
  return formatDateTime(value);
}

function readableEvents(events: AgentEventEnvelope[]): AgentEventEnvelope[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const body = eventBody(event).trim();
    if (!body) return false;
    if (event.payload.type === "user_message") return true;
    if (seen.has(body)) return false;
    seen.add(body);
    return true;
  });
}

function finalSummaryEvent(events: AgentEventEnvelope[], spec?: TaskSpec): AgentEventEnvelope | undefined {
  const specText = spec?.contentMarkdown.trim();
  return [...events].reverse().find((event) => {
    if (event.payload.type !== "completed" || !event.payload.summary?.trim()) return false;
    return event.payload.summary.trim() !== specText;
  });
}

function suggestedProjectMemory(task: TaskSummary | undefined, summary: string): string {
  if (!task || !summary.trim()) return "";
  return [
    `Task #${task.taskNumber}: ${task.title}`,
    "",
    summary.trim().slice(0, 3_500),
  ].join("\n");
}

function taskActivityLabel(task: TaskSummary): string {
  if (task.status === "WAITING_USER" && task.pendingQuestions.length > 0) {
    return `Question: ${task.pendingQuestions[0]?.prompt ?? ""}`;
  }
  if (task.status === "READY_TO_RESUME" && task.autoResumeAt) {
    return `Resume available ${activityTime(task.autoResumeAt)}`;
  }
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

interface ImageAttachmentPickerProps {
  images: ConversationImageAttachment[];
  disabled?: boolean;
  onChange(images: ConversationImageAttachment[]): void;
}

function ImageAttachmentPicker({ images, disabled = false, onChange }: ImageAttachmentPickerProps): React.JSX.Element {
  const [error, setError] = useState("");

  async function attach(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setError("");
    try {
      const remaining = maxAttachedImages - images.length;
      if (remaining <= 0) throw new Error("Remove an image before attaching another one.");
      const selected = Array.from(files).slice(0, remaining);
      const next = await Promise.all(selected.map(readImageAttachment));
      onChange([...images, ...next]);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="image-attachments">
      <label className="button secondary compact">
        Attach image
        <input
          type="file"
          accept={conversationImageMediaTypes.join(",")}
          multiple
          disabled={disabled || images.length >= maxAttachedImages}
          onChange={(event) => {
            void attach(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {images.length > 0 && (
        <div className="attachment-list">
          {images.map((image, index) => (
            <span className="attachment-chip" key={`${image.name}-${index}`}>
              {image.name} - {imageSizeLabel(image.sizeBytes)}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(images.filter((_, imageIndex) => imageIndex !== index))}
                aria-label={`Remove ${image.name}`}
              >
                X
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <small className="attachment-error">{error}</small>}
    </div>
  );
}

interface EventViewerProps {
  title: string;
  events: AgentEventEnvelope[];
  spec?: TaskSpec;
  reviewTask?: TaskSummary;
  initialTab?: EventTab;
  onClose(): void;
  onApprove?(task: TaskSummary): Promise<void>;
  onRequestChanges?(task: TaskSummary, feedback: string, images?: ConversationImageAttachment[]): Promise<void>;
  onAnswerQuestion?(task: TaskSummary, answers: Array<{ questionId: string; answer: string }>, images?: ConversationImageAttachment[]): Promise<void>;
  onRetryBrainstorm?(task: TaskSummary): Promise<void>;
  onRunTask?(task: TaskSummary): Promise<void>;
  onReviewExecution?(input: ExecutionReviewDecisionInput): Promise<void>;
}

function EventViewer({
  title,
  events,
  spec,
  reviewTask,
  initialTab = "summary",
  onClose,
  onApprove,
  onRequestChanges,
  onAnswerQuestion,
  onRetryBrainstorm,
  onRunTask,
  onReviewExecution,
}: EventViewerProps): React.JSX.Element {
  const richEvents = readableEvents(events);
  const isReviewFlow = Boolean(reviewTask);
  const [reviewing, setReviewing] = useState<"approve" | "changes" | "retry" | "run" | null>(null);
  const [eventTab, setEventTab] = useState<EventTab>(initialTab);
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [eventSearch, setEventSearch] = useState("");
  const [feedback, setFeedback] = useState("");
  const [feedbackImages, setFeedbackImages] = useState<ConversationImageAttachment[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answerImages, setAnswerImages] = useState<Record<string, ConversationImageAttachment[]>>({});
  const filteredEvents = events.filter((event) => eventMatchesFilter(event, eventFilter) && eventMatchesSearch(event, eventSearch));
  const usage = summarizeUsage(events);
  const hasUsage = usage.sessions > 0 || Boolean(usage.latestContext);
  const modelUsageRows = Object.entries(usage.byModel).sort((left, right) => right[1].costUsd - left[1].costUsd);
  const groupedEvents = Object.entries(
    filteredEvents.reduce<Record<string, AgentEventEnvelope[]>>((groups, event) => {
      groups[event.sessionId] = [...(groups[event.sessionId] ?? []), event];
      return groups;
    }, {}),
  );
  const initialPromptEvent = events.find(
    (event) => event.payload.type === "user_message" && event.payload.kind === "initial_prompt",
  );
  const taskFinalSummaryEvent = finalSummaryEvent(events, spec);
  const finalSummaryText = taskFinalSummaryEvent ? eventBody(taskFinalSummaryEvent) : "";
  const [saveMemoryUpdate, setSaveMemoryUpdate] = useState(false);
  const [memoryUpdateDraft, setMemoryUpdateDraft] = useState("");
  const failureEvents = events.filter((event) => event.payload.type === "failed" || event.payload.type === "tool_failed");
  const latestFailure = failureEvents.at(-1);
  const showCurrentFailure = Boolean(
    latestFailure && reviewTask && ["FAILED", "BLOCKED", "INTERRUPTED", "CANCELLED"].includes(reviewTask.status),
  );
  const action = actionBanner(reviewTask);
  const claudeWaitLabel =
    reviewing === "changes"
      ? reviewTask?.status === "WAITING_USER"
        ? "Sending answer to Claude..."
        : reviewTask?.status === "DESIGN_REVIEW"
          ? "Asking Claude to revise the spec..."
          : "Resuming Claude execution..."
      : "";

  useEffect(() => {
    if (reviewTask?.status !== "EXECUTION_REVIEW") {
      setSaveMemoryUpdate(false);
      setMemoryUpdateDraft("");
      return;
    }
    setSaveMemoryUpdate(false);
    setMemoryUpdateDraft(suggestedProjectMemory(reviewTask, finalSummaryText));
  }, [reviewTask?.id, reviewTask?.status, finalSummaryText]);

  useEffect(() => {
    setEventTab(initialTab);
  }, [initialTab, reviewTask?.id]);

  async function approve(): Promise<void> {
    if (!reviewTask) return;
    setReviewing("approve");
    try {
      if (reviewTask.status === "EXECUTION_REVIEW") {
        await onReviewExecution?.({
          taskId: reviewTask.id,
          decision: "complete",
          ...(saveMemoryUpdate && memoryUpdateDraft.trim() ? { memoryUpdate: memoryUpdateDraft } : {}),
        });
      } else {
        await onApprove?.(reviewTask);
      }
      onClose();
    } finally {
      setReviewing(null);
    }
  }

  async function requestChanges(): Promise<void> {
    if (!reviewTask || !feedback.trim()) return;
    setReviewing("changes");
    try {
      if (reviewTask.status === "EXECUTION_REVIEW") {
        await onReviewExecution?.({ taskId: reviewTask.id, decision: "changes", feedback });
      } else {
        await onRequestChanges?.(reviewTask, feedback, feedbackImages);
      }
      setFeedback("");
      setFeedbackImages([]);
    } finally {
      setReviewing(null);
    }
  }

  const pendingQuestionAnswers = reviewTask?.pendingQuestions.map((question) => ({
    questionId: question.id,
    answer: (answers[question.id] ?? "").trim(),
  })) ?? [];
  const canSubmitAnswers =
    reviewTask?.status === "WAITING_USER" &&
    pendingQuestionAnswers.length > 0 &&
    pendingQuestionAnswers.every((answer) => answer.answer.length > 0);

  async function submitAnswers(): Promise<void> {
    if (!reviewTask || !canSubmitAnswers) return;
    setReviewing("changes");
    try {
      await onAnswerQuestion?.(reviewTask, pendingQuestionAnswers, Object.values(answerImages).flat());
      setAnswers({});
      setAnswerImages({});
    } finally {
      setReviewing(null);
    }
  }

  async function retry(): Promise<void> {
    if (!reviewTask) return;
    setReviewing("retry");
    try {
      await onRetryBrainstorm?.(reviewTask);
    } finally {
      setReviewing(null);
    }
  }

  async function runTask(): Promise<void> {
    if (!reviewTask) return;
    setReviewing("run");
    try {
      await onRunTask?.(reviewTask);
    } finally {
      setReviewing(null);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog event-dialog" role="dialog" aria-modal="true" aria-labelledby="event-dialog-title">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">{isReviewFlow ? "TASK REVIEW" : "TASK EVENTS"}</p>
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
          {action && (
            <section className="action-banner" data-tone={action.tone} role="status">
              <strong>{action.title}</strong>
              <span>{action.detail}</span>
            </section>
          )}
          <div className="event-tabs" role="tablist" aria-label="Task event views">
            {[
              ["summary", "Summary"],
              ["conversation", "Conversation"],
              ["technical", "Technical"],
            ].map(([id, label]) => (
              <button
                type="button"
                className={eventTab === id ? "active" : ""}
                key={id}
                onClick={() => setEventTab(id as EventTab)}
              >
                {label}
              </button>
            ))}
          </div>
          {eventTab === "summary" && (
            <>
              <div className="event-summary-grid">
                <article>
                  <span>Status</span>
                  {reviewTask ? <StatusBadge status={reviewTask.status} /> : <strong>Session</strong>}
                </article>
                <article>
                  <span>Events</span>
                  <strong>{events.length}</strong>
                </article>
                <article>
                  <span>Sessions</span>
                  <strong>{new Set(events.map((event) => event.sessionId)).size || 1}</strong>
                </article>
                <article>
                  <span>Duration</span>
                  <strong>{eventDuration(events)}</strong>
                </article>
                {hasUsage && (
                  <>
                    <article>
                      <span>Cost</span>
                      <strong>{formatUsd(usage.totalCostUsd)}</strong>
                    </article>
                    <article>
                      <span>Tokens</span>
                      <strong>{formatCompactNumber(totalUsageTokens(usage))}</strong>
                    </article>
                    {usage.latestContext && (
                      <article>
                        <span>Context</span>
                        <strong>{usage.latestContext.percentage}%</strong>
                      </article>
                    )}
                  </>
                )}
                {spec && (
                  <article>
                    <span>Spec</span>
                    <strong>v{spec.version}</strong>
                  </article>
                )}
              </div>
              {showCurrentFailure && latestFailure && (
                <section className="latest-failure" aria-label="Latest failure">
                  <strong>Latest failure</strong>
                  <p>{eventBody(latestFailure)}</p>
                </section>
              )}
              {hasUsage && (
                <section className="usage-panel" aria-label="Claude usage">
                  <div className="section-heading compact">
                    <h3>Claude usage</h3>
                    <span>{usage.sessions} {usage.sessions === 1 ? "session" : "sessions"}</span>
                  </div>
                  <div className="usage-metrics">
                    <article><span>Input</span><strong>{formatCompactNumber(usage.inputTokens)}</strong></article>
                    <article><span>Output</span><strong>{formatCompactNumber(usage.outputTokens)}</strong></article>
                    <article><span>Cache read</span><strong>{formatCompactNumber(usage.cacheReadInputTokens)}</strong></article>
                    <article><span>Cache write</span><strong>{formatCompactNumber(usage.cacheCreationInputTokens)}</strong></article>
                    <article><span>Thinking</span><strong>{formatCompactNumber(usage.thinkingTokens)}</strong></article>
                    <article><span>Web search</span><strong>{usage.webSearchRequests}</strong></article>
                  </div>
                  {usage.latestContext && (
                    <div className="context-meter" aria-label="Context usage">
                      <div>
                        <strong>{usage.latestContext.model}</strong>
                        <span>{formatCompactNumber(usage.latestContext.totalTokens)} / {formatCompactNumber(usage.latestContext.maxTokens)} tokens</span>
                      </div>
                      <div className="context-track">
                        <span style={{ width: `${Math.min(100, usage.latestContext.percentage)}%` }} />
                      </div>
                    </div>
                  )}
                  {modelUsageRows.length > 0 && (
                    <div className="usage-model-list">
                      {modelUsageRows.map(([model, modelUsage]) => (
                        <div className="usage-model-row" key={model}>
                          <div>
                            <strong>{model}</strong>
                            <span>{formatCompactNumber(totalUsageTokens(modelUsage))} tokens</span>
                          </div>
                          <strong>{formatUsd(modelUsage.costUsd)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {initialPromptEvent && (
                <section className="response-panel" aria-label="Initial prompt">
                  <h3>Initial Prompt</h3>
                  <article className="user-response">
                    <span>#{initialPromptEvent.sequence} user - {eventTime(initialPromptEvent)}</span>
                    <pre>{eventBody(initialPromptEvent)}</pre>
                  </article>
                </section>
              )}
              {spec && (
                <section className="response-panel" aria-label="Current spec">
                  <h3>Stored Spec</h3>
                  <article>
                    <span>v{spec.version} - {spec.sha256.slice(0, 12)}</span>
                    <pre>{spec.contentMarkdown}</pre>
                  </article>
                </section>
              )}
              {taskFinalSummaryEvent && (
                <section className="response-panel" aria-label="Final summary">
                  <h3>Final Summary</h3>
                  <article>
                    <span>#{taskFinalSummaryEvent.sequence} completed - {eventTime(taskFinalSummaryEvent)}</span>
                    <pre>{eventBody(taskFinalSummaryEvent)}</pre>
                  </article>
                </section>
              )}
            </>
          )}
          {eventTab === "conversation" && (
            <>
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
                              className={(answers[question.id] ?? "") === option ? "button primary" : "button secondary"}
                              disabled={reviewing !== null}
                              key={option}
                              onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}
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
                          <ImageAttachmentPicker
                            images={answerImages[question.id] ?? []}
                            disabled={reviewing !== null}
                            onChange={(images) => setAnswerImages((current) => ({ ...current, [question.id]: images }))}
                          />
                        </div>
                      )}
                    </article>
                  ))}
                  <div className="question-submit-row">
                    <span>
                      {pendingQuestionAnswers.filter((answer) => answer.answer).length} of {pendingQuestionAnswers.length} answered
                    </span>
                    <button
                      type="button"
                      className="button primary"
                      disabled={reviewing !== null || !canSubmitAnswers}
                      onClick={() => void submitAnswers()}
                    >
                      {reviewing === "changes" ? "Sending..." : "Send answers"}
                    </button>
                  </div>
                </section>
              )}
              {richEvents.length > 0 ? (
                <section className="response-panel" aria-label="Readable responses">
                  <h3>Responses</h3>
                  {richEvents.map((event) => (
                    <article className={event.payload.type === "user_message" ? "user-response" : ""} key={event.eventId}>
                      <span>
                        #{event.sequence} {event.payload.type === "user_message" ? `user ${event.payload.kind}` : event.payload.type} - {eventTime(event)}
                      </span>
                      <pre>{eventBody(event)}</pre>
                    </article>
                  ))}
                </section>
              ) : (
                <p className="event-empty">No readable conversation events yet.</p>
              )}
            </>
          )}
          {eventTab === "technical" && (
            <section className="technical-events">
              <header>
                <span>Events</span>
                <small>{filteredEvents.length} of {events.length}</small>
              </header>
            <div className="event-tools">
              <div className="event-filter-tabs" role="tablist" aria-label="Event filters">
                {eventFilters.map((filter) => (
                  <button
                    type="button"
                    className={eventFilter === filter.id ? "active" : ""}
                    key={filter.id}
                    onClick={() => setEventFilter(filter.id)}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <input
                value={eventSearch}
                placeholder="Search events"
                onChange={(event) => setEventSearch(event.currentTarget.value)}
              />
            </div>
            <section className="event-details-list" aria-label="All session events">
              {groupedEvents.length === 0 ? (
                <p className="event-empty">No events match this filter.</p>
              ) : (
                groupedEvents.map(([sessionId, sessionEvents]) => (
                  <section className="event-session-group" key={sessionId}>
                    <header>
                      <strong>Session</strong>
                      <code>{sessionId}</code>
                      <span>{sessionEvents.length} events - {eventDuration(sessionEvents)}</span>
                    </header>
                    {sessionEvents.map((event) => (
                      <details
                        className="event-details"
                        key={event.eventId}
                        open={!isReviewFlow && (
                          event.payload.type === "user_message" ||
                          event.payload.type === "message_completed" ||
                          event.payload.type === "completed" ||
                          event.payload.type === "failed"
                        )}
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
                ))
              )}
            </section>
          </section>
          )}
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
            <ImageAttachmentPicker images={feedbackImages} disabled={reviewing !== null} onChange={setFeedbackImages} />
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
        {reviewTask?.status === "EXECUTION_REVIEW" && (
          <footer className="dialog-actions event-actions">
            <div className="memory-review-box">
              <label className="memory-toggle">
                <span>
                  <strong>Save useful outcome to project memory</strong>
                  <small>Only durable project knowledge should go here. Leave off to keep this task only in Related tasks/history.</small>
                </span>
                <input
                  type="checkbox"
                  checked={saveMemoryUpdate}
                  disabled={reviewing !== null}
                  onChange={(event) => setSaveMemoryUpdate(event.currentTarget.checked)}
                />
              </label>
              <textarea
                value={memoryUpdateDraft}
                maxLength={4000}
                disabled={reviewing !== null || !saveMemoryUpdate}
                placeholder="Add reusable decisions, domain rules, or constraints learned from this task."
                onChange={(event) => setMemoryUpdateDraft(event.target.value)}
              />
            </div>
            <textarea
              className="review-feedback"
              value={feedback}
              placeholder="Describe what Claude should fix if this is not ready."
              disabled={reviewing !== null}
              onChange={(event) => setFeedback(event.target.value)}
            />
            <button
              type="button"
              className="button secondary"
              disabled={reviewing !== null || !feedback.trim()}
              onClick={() => void requestChanges()}
            >
              {reviewing === "changes" ? "Resuming..." : "Needs Changes"}
            </button>
            <button type="button" className="button primary" disabled={reviewing !== null} onClick={() => void approve()}>
              {reviewing === "approve" ? "Saving..." : "Mark Done"}
            </button>
          </footer>
        )}
        {reviewTask && canRetryBrainstorm(reviewTask) && (
          <footer className="dialog-actions">
            <button type="button" className="button secondary" disabled={reviewing !== null} onClick={onClose}>
              Close
            </button>
            <button type="button" className="button primary" disabled={reviewing !== null} onClick={() => void retry()}>
              {reviewing === "retry" ? brainstormActionLabel(reviewTask, reviewTask.id) : brainstormActionLabel(reviewTask, null)}
            </button>
          </footer>
        )}
        {reviewTask && canRunTask(reviewTask) && (
          <footer className="dialog-actions">
            <button type="button" className="button secondary" disabled={reviewing !== null} onClick={onClose}>
              Close
            </button>
            <button type="button" className="button primary" disabled={reviewing !== null} onClick={() => void runTask()}>
              {reviewing === "run" ? taskRunLabel(reviewTask, reviewTask.id) : taskRunLabel(reviewTask, null)}
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
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryLoading, setMemoryLoading] = useState(Boolean(project));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!project) {
      setMemoryDraft("");
      setMemoryLoading(false);
      return;
    }
    setMemoryLoading(true);
    void appApi()
      .getProjectMemory(project.id)
      .then((memory) => setMemoryDraft(memory.contentMarkdown))
      .catch((caught) => setError(errorMessage(caught)))
      .finally(() => setMemoryLoading(false));
  }, [project]);

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
        await appApi().updateProjectMemory({ projectId: project.id, contentMarkdown: memoryDraft });
      } else {
        const created = await projectApi().create(draft);
        if (memoryDraft.trim()) {
          await appApi().updateProjectMemory({ projectId: created.id, contentMarkdown: memoryDraft });
        }
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
          <label>
            Project memory
            <textarea
              value={memoryDraft}
              maxLength={40000}
              disabled={saving || memoryLoading}
              placeholder="Add durable project context: architecture decisions, domain rules, important paths, conventions, or constraints."
              onChange={(event) => setMemoryDraft(event.target.value)}
            />
          </label>
          <p className="form-hint">
            {memoryLoading ? "Loading project memory..." : `${memoryDraft.length.toLocaleString()} / 40,000 chars`}
          </p>
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
  task?: TaskSummary;
  availableTasks: TaskSummary[];
  onClose(): void;
  onSaved(): Promise<void>;
  onStarted(result: BrainstormResult): Promise<void>;
}

function TaskForm({ project, task, availableTasks, onClose, onSaved, onStarted }: TaskFormProps): React.JSX.Element {
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [model, setModel] = useState<AgentModelOption>(task?.model ?? "default");
  const [effort, setEffort] = useState<AgentEffortOption>(task?.effort ?? "default");
  const [includeProjectMemory, setIncludeProjectMemory] = useState(true);
  const [contextTaskIds, setContextTaskIds] = useState<string[]>(task?.contextTaskIds ?? []);
  const [images, setImages] = useState<ConversationImageAttachment[]>([]);
  const [error, setError] = useState("");
  const [savingAction, setSavingAction] = useState<"draft" | "brainstorm" | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const contextTasks = availableTasks.filter((candidate) => candidate.id !== task?.id).slice(0, 8);
  const saving = savingAction !== null;

  useEffect(() => {
    if (!startedAt) return undefined;
    setElapsedSeconds(0);
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  function draftInput(): Parameters<Window["anubis"]["app"]["startBrainstorm"]>[0] {
    return {
      projectId: project.id,
      title,
      description,
      model,
      effort,
      includeProjectMemory,
      contextTaskIds,
      ...(images.length > 0 ? { images } : {}),
    };
  }

  async function saveDraft(): Promise<void> {
    setError("");
    setSavingAction("draft");
    try {
      if (task) {
        await appApi().updateTaskDraft(task.id, draftInput());
      } else {
        await appApi().createTaskDraft(draftInput());
      }
      await onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingAction(null);
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setSavingAction("brainstorm");
    setStartedAt(Date.now());
    try {
      if (task) {
        await appApi().updateTaskDraft(task.id, draftInput());
      }
      const result = task ? await appApi().retryBrainstorm(task.id) : await appApi().startBrainstorm(draftInput());
      await onStarted(result);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingAction(null);
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
      <section className="dialog task-dialog" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">LOCAL TASK</p>
            <h2 id="task-dialog-title">{task ? "Edit draft" : "New task"}</h2>
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
          <div className="form-grid">
            <label>
              Model
              <select value={model} disabled={saving} onChange={(event) => setModel(event.target.value as AgentModelOption)}>
                {agentModelOptions.map((option) => (
                  <option value={option} key={option}>{agentModelLabels[option]}</option>
                ))}
              </select>
            </label>
            <label>
              Effort
              <select value={effort} disabled={saving} onChange={(event) => setEffort(event.target.value as AgentEffortOption)}>
                {agentEffortOptions.map((option) => (
                  <option value={option} key={option}>{agentEffortLabels[option]}</option>
                ))}
              </select>
            </label>
          </div>
          <section className="memory-options" aria-label="Task memory context">
            <label className="memory-toggle">
              <span>
                <strong>Project memory</strong>
                <small>Include durable notes and decisions saved for this project.</small>
              </span>
              <input
                type="checkbox"
                checked={includeProjectMemory}
                disabled={saving}
                onChange={(event) => setIncludeProjectMemory(event.target.checked)}
              />
            </label>
            {contextTasks.length > 0 && (
              <div className="context-task-list">
                <div className="context-task-heading">
                  <strong>Related tasks</strong>
                  <span>Optional context for Claude</span>
                </div>
                {contextTasks.map((task) => (
                  <label className="context-task-option" key={task.id}>
                    <input
                      type="checkbox"
                      checked={contextTaskIds.includes(task.id)}
                      disabled={saving}
                      onChange={(event) => {
                        setContextTaskIds((current) =>
                          event.target.checked ? [...current, task.id] : current.filter((id) => id !== task.id),
                        );
                      }}
                    />
                    <span>
                      <strong>#{task.taskNumber} {task.title}</strong>
                      <small>{task.status} - {taskActivityLabel(task)}</small>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
          <ImageAttachmentPicker images={images} disabled={saving} onChange={setImages} />
          <p className="form-hint">Save a draft for later, or start a Claude brainstorm now.</p>
          {savingAction === "brainstorm" && (
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
            <button type="button" className="button secondary" disabled={saving} onClick={() => void saveDraft()}>
              {savingAction === "draft" ? "Saving..." : "Save draft"}
            </button>
            <button className="button primary" disabled={saving}>{savingAction === "brainstorm" ? "Starting..." : "Start brainstorm"}</button>
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
  onEditDraft(task: TaskSummary): void | Promise<void>;
  onRunTask(task: TaskSummary): Promise<void>;
  onRetryBrainstorm(task: TaskSummary): Promise<void>;
}

function ProjectTasksDialog({
  project,
  tasks,
  loading,
  executingTaskId,
  onClose,
  onOpenTask,
  onEditDraft,
  onRunTask,
  onRetryBrainstorm,
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
                    <small>
                      {task.eventCount} events - {taskAgentLabel(task)}
                      {task.completedDurationSeconds ? ` - ${formatDuration(task.completedDurationSeconds)}` : ""}
                    </small>
                  </div>
                  <StatusBadge status={task.status} />
                  <p>{taskActivityLabel(task)}</p>
                  <div className="task-actions">
                    {project.enabled && task.status === "DRAFT" && (
                      <button className="text-button" disabled={executingTaskId !== null} onClick={() => void onEditDraft(task)}>
                        Edit
                      </button>
                    )}
                    {project.enabled && canRunTask(task) && (
                      <button className="text-button" disabled={executingTaskId !== null} onClick={() => void onRunTask(task)}>
                        {taskRunLabel(task, executingTaskId)}
                      </button>
                    )}
                    {project.enabled && canRetryBrainstorm(task) && (
                      <button className="text-button" disabled={executingTaskId !== null} onClick={() => void onRetryBrainstorm(task)}>
                        {brainstormActionLabel(task, executingTaskId)}
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
  error: string;
  onClose(): void;
}

function ProjectStatsDialog({
  project,
  stats,
  loading,
  error,
  onClose,
}: ProjectStatsDialogProps): React.JSX.Element {
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
          {loading ? (
            <section className="loading-state compact"><div className="spinner" />Loading stats...</section>
          ) : error && !stats ? (
            <div className="empty-review">
              <p className="eyebrow">STATS UNAVAILABLE</p>
              <h2>Could not load project stats</h2>
              <p>{error}</p>
            </div>
          ) : !stats ? (
            <div className="empty-review">
              <p className="eyebrow">NO STATS</p>
              <h2>No project stats yet</h2>
              <p>Stats will appear after this project has tasks or events.</p>
            </div>
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
                <div>
                  <span>Claude cost</span>
                  <strong>{formatUsd(stats.usage.totalCostUsd)}</strong>
                </div>
                <div>
                  <span>Total duration</span>
                  <strong>{formatDuration(stats.totalCompletedDurationSeconds)}</strong>
                </div>
                <div>
                  <span>Avg task time</span>
                  <strong>{formatDuration(stats.averageCompletedDurationSeconds)}</strong>
                </div>
                <div>
                  <span>Cost per hour</span>
                  <strong>{formatUsdPerHour(stats.costPerCompletedHourUsd)}</strong>
                </div>
                <div>
                  <span>Tokens</span>
                  <strong>{formatCompactNumber(totalUsageTokens(stats.usage))}</strong>
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
              <section className="stats-section">
                <div className="section-heading compact">
                  <h3>Claude usage</h3>
                  <span>{stats.usage.sessions} {stats.usage.sessions === 1 ? "session" : "sessions"} with usage</span>
                </div>
                <div className="usage-metrics">
                  <article><span>Input</span><strong>{formatCompactNumber(stats.usage.inputTokens)}</strong></article>
                  <article><span>Output</span><strong>{formatCompactNumber(stats.usage.outputTokens)}</strong></article>
                  <article><span>Cache read</span><strong>{formatCompactNumber(stats.usage.cacheReadInputTokens)}</strong></article>
                  <article><span>Cache write</span><strong>{formatCompactNumber(stats.usage.cacheCreationInputTokens)}</strong></article>
                  <article><span>Thinking</span><strong>{formatCompactNumber(stats.usage.thinkingTokens)}</strong></article>
                  <article><span>Web search</span><strong>{stats.usage.webSearchRequests}</strong></article>
                </div>
                {stats.usage.latestContext && (
                  <div className="context-meter">
                    <div>
                      <strong>{stats.usage.latestContext.model}</strong>
                      <span>{stats.usage.latestContext.percentage}% context - {formatCompactNumber(stats.usage.latestContext.totalTokens)} / {formatCompactNumber(stats.usage.latestContext.maxTokens)}</span>
                    </div>
                    <div className="context-track">
                      <span style={{ width: `${Math.min(100, stats.usage.latestContext.percentage)}%` }} />
                    </div>
                  </div>
                )}
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
  const [taskForm, setTaskForm] = useState<{ project: Project; task?: TaskSummary } | null>(null);
  const [projectTasksDialog, setProjectTasksDialog] = useState<Project | null>(null);
  const [projectStatsDialog, setProjectStatsDialog] = useState<Project | null>(null);
  const [projectTasks, setProjectTasks] = useState<TaskSummary[]>([]);
  const [projectTasksLoading, setProjectTasksLoading] = useState(false);
  const [projectStatsLoading, setProjectStatsLoading] = useState(false);
  const [executingTaskId, setExecutingTaskId] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
  const [brainstormResult, setBrainstormResult] = useState<BrainstormResult | null>(null);
  const [sessionEvents, setSessionEvents] = useState<AgentEventEnvelope[]>([]);
  const [eventPanelTitle, setEventPanelTitle] = useState("Task activity");
  const [eventViewerOpen, setEventViewerOpen] = useState(false);
  const [eventInitialTab, setEventInitialTab] = useState<EventTab>("summary");
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
          appApi().listTaskEvents(updatedTask.id),
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

  async function unarchive(project: Project): Promise<void> {
    try {
      await projectApi().unarchive(project.id);
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

  async function viewTaskEvents(task: TaskSummary, initialTab: EventTab = "summary"): Promise<void> {
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
        appApi().listTaskEvents(task.id),
        appApi().getLatestSpec(task.id),
      ]);
      setSessionEvents(events);
      setActiveSpec(spec);
      setActiveReviewTask(task);
      setEventInitialTab(initialTab);
      setEventViewerOpen(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function editDraft(project: Project, task: TaskSummary): Promise<void> {
    setError("");
    try {
      const freshTasks = await appApi().listTasks(project.id, null);
      const freshTask = freshTasks.find((candidate) => candidate.id === task.id) ?? task;
      setTasksByProject((current) => ({ ...current, [project.id]: freshTasks }));
      setProjectTasksDialog(null);
      setProjectTasks([]);
      setTaskForm({ project, task: freshTask });
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

  async function reviewExecution(input: ExecutionReviewDecisionInput): Promise<void> {
    setError("");
    setExecutingTaskId(input.taskId);
    try {
      const updated = await appApi().reviewExecution(input);
      if (input.decision === "changes") {
        const result = await appApi().startTaskExecution(updated.id);
        const [events, projectTasks, projectStats] = await Promise.all([
          appApi().listSessionEvents(result.sessionId),
          appApi().listTasks(updated.projectId),
          appApi().getProjectStats(updated.projectId),
        ]);
        const openProjectTasks =
          projectTasksDialog?.id === updated.projectId ? await appApi().listTasks(updated.projectId, null) : null;
        setExecutionResult(result);
        setBrainstormResult(null);
        setEventPanelTitle(`Task #${updated.taskNumber}: ${updated.title}`);
        setSessionEvents(events);
        setActiveSpec(null);
        setActiveReviewTask(projectTasks.find((candidate) => candidate.id === updated.id) ?? null);
        setTasksByProject((current) => ({ ...current, [updated.projectId]: projectTasks }));
        setStatsByProject((current) => ({ ...current, [updated.projectId]: projectStats }));
        if (openProjectTasks) setProjectTasks(openProjectTasks);
        setEventViewerOpen(true);
        return;
      }
      const [projectTasks, projectStats, events] = await Promise.all([
        appApi().listTasks(updated.projectId),
        appApi().getProjectStats(updated.projectId),
        appApi().listTaskEvents(updated.id),
      ]);
      const openProjectTasks =
        projectTasksDialog?.id === updated.projectId ? await appApi().listTasks(updated.projectId, null) : null;
      setTasksByProject((current) => ({ ...current, [updated.projectId]: projectTasks }));
      setStatsByProject((current) => ({ ...current, [updated.projectId]: projectStats }));
      setSessionEvents(events);
      if (openProjectTasks) setProjectTasks(openProjectTasks);
      await loadProjects();
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    } finally {
      setExecutingTaskId(null);
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
      setActiveReviewTask(projectTasks.find((candidate) => candidate.id === task.id) ?? null);
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

  async function retryBrainstorm(task: TaskSummary): Promise<void> {
    setExecutingTaskId(task.id);
    setError("");
    setBrainstormResult(null);
    setExecutionResult(null);
    try {
      const result = await appApi().retryBrainstorm(task.id);
      const [events, spec, projectTasks, projectStats] = await Promise.all([
        appApi().listSessionEvents(result.sessionId),
        appApi().getLatestSpec(task.id),
        appApi().listTasks(task.projectId),
        appApi().getProjectStats(task.projectId),
      ]);
      const openProjectTasks =
        projectTasksDialog?.id === task.projectId ? await appApi().listTasks(task.projectId, null) : null;
      setBrainstormResult(result);
      setEventPanelTitle(`Task #${task.taskNumber}: ${task.title}`);
      setSessionEvents(events);
      setActiveSpec(spec);
      setActiveReviewTask(projectTasks.find((candidate) => candidate.id === task.id) ?? null);
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

  async function requestChanges(
    task: TaskSummary,
    feedback: string,
    images: ConversationImageAttachment[] = [],
  ): Promise<void> {
    setError("");
    try {
      const result = await appApi().reviseBrainstorm({
        taskId: task.id,
        feedback,
        ...(images.length > 0 ? { images } : {}),
      });
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

  async function answerQuestion(
    task: TaskSummary,
    answers: Array<{ questionId: string; answer: string }>,
    images: ConversationImageAttachment[] = [],
  ): Promise<void> {
    setError("");
    try {
      const result = await appApi().answerQuestion({
        taskId: task.id,
        answers,
        ...(images.length > 0 ? { images } : {}),
      });
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
  const boardTasks: ReviewTask[] = activeProjects.flatMap((project) =>
    (tasksByProject[project.id] ?? []).map((task) => ({ project, task })),
  ).sort((left, right) => Date.parse(right.task.latestActivityAt) - Date.parse(left.task.latestActivityAt));
  const attentionTasks = boardTasks.filter(({ task }) => needsAttention(task));
  const attentionGroups = [
    { id: "questions", title: "Questions", tasks: attentionTasks.filter(({ task }) => task.status === "WAITING_USER") },
    { id: "review", title: "Spec review", tasks: attentionTasks.filter(({ task }) => task.status === "DESIGN_REVIEW") },
    { id: "execution-review", title: "Execution review", tasks: attentionTasks.filter(({ task }) => task.status === "EXECUTION_REVIEW") },
    { id: "resume", title: "Resume", tasks: attentionTasks.filter(({ task }) => task.status === "READY_TO_RESUME") },
    {
      id: "failed",
      title: "Stopped",
      tasks: attentionTasks.filter(({ task }) => ["FAILED", "BLOCKED", "INTERRUPTED"].includes(task.status)),
    },
  ];
  const historyTasks = boardTasks.filter(({ task }) =>
    ["DONE", "FAILED", "INTERRUPTED", "CANCELLED"].includes(task.status),
  );
  const hasModal = Boolean(formProject || taskForm || projectTasksDialog || projectStatsDialog || eventViewerOpen);

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
            {attentionTasks.length > 0 && <span className="nav-count">{attentionTasks.length}</span>}
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
          <p>Local AI workbench</p>
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
        {!loading && view !== "settings" && (
          <section className="runtime-bar" aria-label="Runtime summary">
            <div>
              <span className="status-dot" />
              <strong>{executingTaskId ? "Claude running" : "Claude idle"}</strong>
            </div>
            <span>{attentionTasks.length} attention</span>
            <span>{boardTasks.filter(({ task }) => task.status === "QUEUED" || task.status === "READY_TO_RESUME").length} queued</span>
            <span>{boardTasks.filter(({ task }) => ["PLANNING", "EXECUTING", "VERIFYING", "BRAINSTORMING"].includes(task.status)).length} active</span>
            <span>{notificationSettings?.autoResumeAfterLimit ? "Auto-resume on" : "Auto-resume off"}</span>
            <span>{notificationSettings?.controlledMaxTurns ? "Turns controlled" : "Provider turns"}</span>
          </section>
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

                <div className="settings-group">
                  <div>
                    <h2>Automation</h2>
                    <p>Controls how Anubis resumes local work after Claude limits reset.</p>
                  </div>
                  <label className="toggle-row">
                    <span>
                      <strong>Auto-resume after Claude limit reset</strong>
                      <small>Resumes tasks automatically when Claude reports a five-hour reset time.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={notificationSettings.autoResumeAfterLimit}
                      disabled={settingsSaving !== null}
                      onChange={(event) =>
                        void updateNotificationSetting("autoResumeAfterLimit", event.currentTarget.checked)
                      }
                    />
                  </label>
                  <label className="toggle-row">
                    <span>
                      <strong>Control max turns</strong>
                      <small>Uses Anubis limits with quadratic growth on retries. Turn this off to let Claude use its default.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={notificationSettings.controlledMaxTurns}
                      disabled={settingsSaving !== null}
                      onChange={(event) =>
                        void updateNotificationSetting("controlledMaxTurns", event.currentTarget.checked)
                      }
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
            {attentionTasks.length === 0 ? (
              <div className="empty-review">
                <p className="eyebrow">CLEAR</p>
                <h2>No task needs attention</h2>
                <p>Questions, specs, resumable sessions, and stopped tasks will appear here.</p>
              </div>
            ) : (
              <div className="attention-groups">
                {attentionGroups.filter((group) => group.tasks.length > 0).map((group) => (
                  <section className="attention-group" key={group.id}>
                    <header>
                      <h2>{group.title}</h2>
                      <span>{group.tasks.length}</span>
                    </header>
                    <div className="review-list">
                      {group.tasks.map(({ project, task }) => {
                        const action = taskAction(task);
                        return (
                          <article className="review-row" data-tone={action.tone} key={task.id}>
                            <div>
                              <span className="review-project">{project.name}</span>
                              <h2>#{task.taskNumber} {task.title}</h2>
                              <div className="review-meta">
                                <StatusBadge status={task.status} />
                                <span>{taskAgentLabel(task)}</span>
                                <span>{task.pendingQuestions.length} questions</span>
                                <span>{task.eventCount} events</span>
                                {task.completedDurationSeconds && <span>{formatDuration(task.completedDurationSeconds)}</span>}
                              </div>
                              <span className="review-latest">{taskActivityLabel(task)}</span>
                              <span className="review-activity">Last activity {activityTime(task.latestActivityAt)}</span>
                            </div>
                            <div className={canRunTask(task) ? "review-action compact-action" : "review-action"}>
                              {canRunTask(task) ? (
                                <>
                                  <button
                                    className="button primary compact"
                                    disabled={executingTaskId !== null}
                                    onClick={() => void startTaskExecution(task)}
                                  >
                                    {taskRunLabel(task, executingTaskId)}
                                  </button>
                                  <button
                                    className="text-button"
                                    disabled={!task.latestSessionId || task.eventCount === 0}
                                    onClick={() => void viewTaskEvents(task)}
                                  >
                                    Open details
                                  </button>
                                </>
                              ) : (
                                <>
                                  <strong>{action.label}</strong>
                                  <span>{action.detail}</span>
                                  <button
                                    className="button secondary"
                                    disabled={!task.latestSessionId || task.eventCount === 0}
                                    onClick={() => void viewTaskEvents(task, task.status === "WAITING_USER" ? "conversation" : "summary")}
                                  >
                                    {task.status === "WAITING_USER" ? "Answer" : "Open"}
                                  </button>
                                </>
                              )}
                              {canRetryBrainstorm(task) && (
                                <button
                                  className="button secondary compact"
                                  disabled={executingTaskId !== null}
                                  onClick={() => void retryBrainstorm(task)}
                                >
                                  {brainstormActionLabel(task, executingTaskId)}
                                </button>
                              )}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
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
                          <article className="board-card" data-tone={statusTone(task.status)} data-attention={needsAttention(task)} key={task.id}>
                            <div className="board-card-top">
                              <span className="board-project">{project.name}</span>
                              <StatusBadge status={task.status} />
                            </div>
                            <h3>#{task.taskNumber} {task.title}</h3>
                            <span className="board-agent">{taskAgentLabel(task)}</span>
                            {task.completedDurationSeconds && <span className="board-agent">{formatDuration(task.completedDurationSeconds)}</span>}
                            <p>{taskActivityLabel(task)}</p>
                            <footer>
                              <span>{taskAction(task).label}</span>
                              <div className="task-actions">
                                {task.status === "DRAFT" && (
                                  <button
                                    className="text-button"
                                    disabled={executingTaskId !== null}
                                    onClick={() => void editDraft(project, task)}
                                  >
                                    Edit
                                  </button>
                                )}
                                {canRunTask(task) && (
                                  <button
                                    className="text-button"
                                    disabled={executingTaskId !== null}
                                    onClick={() => void startTaskExecution(task)}
                                  >
                                    {taskRunLabel(task, executingTaskId)}
                                  </button>
                                )}
                                {canRetryBrainstorm(task) && (
                                  <button
                                    className="text-button"
                                    disabled={executingTaskId !== null}
                                    onClick={() => void retryBrainstorm(task)}
                                  >
                                    {brainstormActionLabel(task, executingTaskId)}
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
                    <StatusBadge status={task.status} />
                    <div>
                      <span className="review-project">{project.name}</span>
                      <h2>#{task.taskNumber} {task.title}</h2>
                      <p>{taskActivityLabel(task)}</p>
                      <span>
                        Last activity {activityTime(task.latestActivityAt)} - {task.eventCount} events - {taskAgentLabel(task)}
                        {task.completedDurationSeconds ? ` - ${formatDuration(task.completedDurationSeconds)}` : ""}
                      </span>
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
                    {(() => {
                      const projectTasksForCard = tasksByProject[project.id] ?? [];
                      const nextAction = projectNextAction(projectTasksForCard);
                      return (
                        <>
                    <div className="project-card-top">
                      <div className="project-symbol">{project.name.slice(0, 2).toUpperCase()}</div>
                      <div className="project-state"><span className="status-dot" />Idle</div>
                    </div>
                    <h3>{project.name}</h3>
                    <p className="project-path" title={project.path}>{project.path}</p>
                    <div className="tags"><span>Claude</span><span>Superpowers</span></div>
                    <div className="project-next-action" data-tone={nextAction.tone}>
                      <strong>{nextAction.label}</strong>
                      <span>{nextAction.detail}</span>
                    </div>
                    {stats && (
                      <div className="project-stats-strip" aria-label={`${project.name} stats`}>
                        <span><strong>{stats.totalTasks}</strong>Tasks</span>
                        <span><strong>{stats.attentionTasks}</strong>Attention</span>
                        <span><strong>{stats.queuedTasks}</strong>Queued</span>
                        <span><strong>{stats.completionRate}%</strong>Done</span>
                        <span><strong>{formatUsd(stats.usage.totalCostUsd)}</strong>Cost</span>
                        <span><strong>{formatDuration(stats.totalCompletedDurationSeconds)}</strong>Time</span>
                        <span><strong>{formatUsdPerHour(stats.costPerCompletedHourUsd)}</strong>Per hour</span>
                      </div>
                    )}
                    <div className="task-list">
                      {projectTasksForCard.length === 0 ? (
                        <p>No tasks yet</p>
                      ) : (
                        projectTasksForCard.slice(0, 3).map((task) => (
                          <div className="task-row" key={task.id}>
                            <div>
                              <strong>#{task.taskNumber} {task.title}</strong>
                              <span>
                                {task.latestSessionStatus ?? "NO_SESSION"} - {task.eventCount} events - {taskAgentLabel(task)}
                                {task.completedDurationSeconds ? ` - ${formatDuration(task.completedDurationSeconds)}` : ""}
                              </span>
                            </div>
                            <StatusBadge status={task.status} />
                            <div className="task-actions">
                              {canRunTask(task) && (
                                <button
                                  className="text-button"
                                  disabled={executingTaskId !== null}
                                  onClick={() => void startTaskExecution(task)}
                                >
                                  {taskRunLabel(task, executingTaskId)}
                                </button>
                              )}
                              {canRetryBrainstorm(task) && (
                                <button
                                  className="text-button"
                                  disabled={executingTaskId !== null}
                                  onClick={() => void retryBrainstorm(task)}
                                >
                                  {brainstormActionLabel(task, executingTaskId)}
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
                          onClick={() => setTaskForm({ project })}
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
                        </>
                      );
                    })()}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {view === "projects" && archivedProjects.length > 0 && (
          <details className="archived-section">
            <summary>Archived projects <span>{archivedProjects.length}</span></summary>
            {archivedProjects.map((project) => (
              <article className="archived-project-row" key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  <small>{project.path}</small>
                </div>
                <div className="project-actions">
                  <button className="text-button" onClick={() => void loadProjectTasksDialog(project)}>All tasks</button>
                  <button className="text-button" onClick={() => void loadProjectStatsDialog(project)}>Stats</button>
                  <button className="text-button" onClick={() => void unarchive(project)}>Unarchive</button>
                </div>
              </article>
            ))}
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
      {taskForm && (
        <TaskForm
          project={taskForm.project}
          {...(taskForm.task ? { task: taskForm.task } : {})}
          availableTasks={tasksByProject[taskForm.project.id] ?? []}
          onClose={() => setTaskForm(null)}
          onSaved={loadProjects}
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
          onEditDraft={(task) => void editDraft(projectTasksDialog, task)}
          onRunTask={startTaskExecution}
          onRetryBrainstorm={retryBrainstorm}
        />
      )}
      {projectStatsDialog && (
        <ProjectStatsDialog
          project={projectStatsDialog}
          stats={statsByProject[projectStatsDialog.id]}
          loading={projectStatsLoading}
          error={error}
          onClose={() => setProjectStatsDialog(null)}
        />
      )}
      {eventViewerOpen && sessionEvents.length > 0 && (
        <EventViewer
          title={eventPanelTitle}
          events={sessionEvents}
          initialTab={eventInitialTab}
          {...(activeSpec ? { spec: activeSpec } : {})}
          onClose={() => setEventViewerOpen(false)}
          onApprove={(task) => reviewTask(task, "approve")}
          onRequestChanges={requestChanges}
          onAnswerQuestion={answerQuestion}
          onRetryBrainstorm={retryBrainstorm}
          onRunTask={startTaskExecution}
          onReviewExecution={reviewExecution}
          {...(activeReviewTask ? { reviewTask: activeReviewTask } : {})}
        />
      )}
    </div>
  );
}
