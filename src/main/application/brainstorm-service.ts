import { createHash, randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventEnvelope, AgentQuestion, FailureClass } from "../../shared/agent-events";
import { conversationImageMediaTypes } from "../../shared/app";
import type {
  BrainstormDraft,
  BrainstormResult,
  BrainstormRevisionInput,
  ConversationImageAttachment,
  QuestionAnswerInput,
  ProjectMemory,
  ProjectMemoryUpdateInput,
  ProjectStats,
  ReviewDecisionInput,
  TaskSpec,
  TaskSummary,
} from "../../shared/app";
import { InputValidationError, parseProjectId } from "../../shared/projects";
import type { AgentSession, Task } from "../../shared/tasks";
import { agentEffortOptions, agentModelOptions } from "../../shared/tasks";
import { AgentJournalRepository } from "../repositories/agent-journal-repository";
import { ProjectRepository } from "../repositories/project-repository";
import type { AgentProvider, ProviderSessionRef } from "../providers/agent-provider";
import { ProviderUnavailableError } from "../providers/agent-provider";
import { ProviderRegistry } from "../providers/provider-registry";
import { superpowersBrainstormPrompt } from "../workflows/superpowers-workflow";
import type { NotificationSink } from "./desktop-notification-service";

const brainstormBaseMaxTurns = 20;

interface TurnBudgetSettings {
  get(): { controlledMaxTurns: boolean };
}

function quadraticTurnBudget(base: number, previousRuns: number): number {
  const runNumber = previousRuns + 1;
  return base * runNumber * runNumber;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new InputValidationError(`${field} must be text.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new InputValidationError(`${field} must contain between 1 and ${maximum} characters.`);
  }
  if (normalized.includes("\0")) throw new InputValidationError(`${field} contains an invalid character.`);
  return normalized;
}

function optionalImages(value: unknown): ConversationImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InputValidationError("Images must be a list.");
  if (value.length > 5) throw new InputValidationError("Attach up to 5 images.");

  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new InputValidationError(`Image ${index + 1} is invalid.`);
    }
    const record = item as Record<string, unknown>;
    const name = requiredText(record.name, `Image ${index + 1} name`, 240);
    if (
      typeof record.mediaType !== "string" ||
      !conversationImageMediaTypes.includes(record.mediaType as ConversationImageAttachment["mediaType"])
    ) {
      throw new InputValidationError(`Image ${index + 1} type is not supported.`);
    }
    if (typeof record.dataBase64 !== "string" || !/^[a-zA-Z0-9+/]+={0,2}$/.test(record.dataBase64)) {
      throw new InputValidationError(`Image ${index + 1} data is invalid.`);
    }
    if (
      typeof record.sizeBytes !== "number" ||
      !Number.isInteger(record.sizeBytes) ||
      record.sizeBytes < 1 ||
      record.sizeBytes > 5 * 1024 * 1024
    ) {
      throw new InputValidationError(`Image ${index + 1} must be 5 MB or smaller.`);
    }
    return {
      name,
      mediaType: record.mediaType as ConversationImageAttachment["mediaType"],
      dataBase64: record.dataBase64,
      sizeBytes: record.sizeBytes,
    };
  });
}

function optionalModel(value: unknown): "default" | "sonnet" | "opus" | "haiku" {
  if (value === undefined) return "default";
  if (typeof value !== "string" || !agentModelOptions.includes(value as "default" | "sonnet" | "opus" | "haiku")) {
    throw new InputValidationError("Model is invalid.");
  }
  return value as "default" | "sonnet" | "opus" | "haiku";
}

function optionalEffort(value: unknown): "default" | "low" | "medium" | "high" | "xhigh" | "max" {
  if (value === undefined) return "default";
  if (typeof value !== "string" || !agentEffortOptions.includes(value as "default" | "low" | "medium" | "high" | "xhigh" | "max")) {
    throw new InputValidationError("Effort is invalid.");
  }
  return value as "default" | "low" | "medium" | "high" | "xhigh" | "max";
}

function promptWithImages(text: string, images: ConversationImageAttachment[]): string | { text: string; images: ConversationImageAttachment[] } {
  return images.length > 0 ? { text, images } : text;
}

function userAttachments(images: ConversationImageAttachment[] | undefined): Array<{ name: string; mediaType: string; sizeBytes: number }> | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((image) => ({
    name: image.name,
    mediaType: image.mediaType,
    sizeBytes: image.sizeBytes,
  }));
}

function initialUserPrompt(input: BrainstormDraft): string {
  return [
    `Task title: ${input.title}`,
    "",
    "Description:",
    input.description,
    "",
    `Model: ${input.model ?? "default"}`,
    `Effort: ${input.effort ?? "default"}`,
    `Include project memory: ${input.includeProjectMemory === false ? "no" : "yes"}`,
    input.contextTaskIds && input.contextTaskIds.length > 0
      ? `Related task IDs: ${input.contextTaskIds.join(", ")}`
      : "",
  ].filter(Boolean).join("\n");
}

function parseBrainstormDraft(value: unknown): BrainstormDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("Expected an object.");
  }
  const record = value as Record<string, unknown>;
  return {
    projectId: parseProjectId(record.projectId),
    title: requiredText(record.title, "Title", 160),
    description: requiredText(record.description, "Description", 4_000),
    model: optionalModel(record.model),
    effort: optionalEffort(record.effort),
    includeProjectMemory: record.includeProjectMemory !== false,
    contextTaskIds: optionalTaskIds(record.contextTaskIds),
    images: optionalImages(record.images),
  };
}

function optionalTaskIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) {
    throw new InputValidationError("Select up to 10 context tasks.");
  }
  return [...new Set(value.map((item) => requiredText(item, "Context task ID", 128)))];
}

function parseProjectMemoryUpdate(value: unknown): ProjectMemoryUpdateInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("Expected a project memory update.");
  }
  const record = value as Record<string, unknown>;
  const contentMarkdown = typeof record.contentMarkdown === "string" ? record.contentMarkdown.trim() : "";
  if (contentMarkdown.length > 40_000) {
    throw new InputValidationError("Project memory is too long.");
  }
  return {
    projectId: parseProjectId(record.projectId),
    contentMarkdown,
  };
}

function parseReviewDecision(value: unknown): ReviewDecisionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("Expected an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.taskId !== "string" || record.taskId.trim().length === 0 || record.taskId.length > 128) {
    throw new InputValidationError("Task ID is invalid.");
  }
  if (record.decision !== "approve" && record.decision !== "changes") {
    throw new InputValidationError("Review decision is invalid.");
  }
  return { taskId: record.taskId.trim(), decision: record.decision };
}

function parseBrainstormRevision(value: unknown): BrainstormRevisionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("Expected an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.taskId !== "string" || record.taskId.trim().length === 0 || record.taskId.length > 128) {
    throw new InputValidationError("Task ID is invalid.");
  }
  return {
    taskId: record.taskId.trim(),
    feedback: requiredText(record.feedback, "Feedback", 4_000),
    images: optionalImages(record.images),
  };
}

function parseQuestionAnswer(value: unknown): QuestionAnswerInput & { answers: Array<{ questionId: string; answer: string }> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("Expected an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.taskId !== "string" || record.taskId.trim().length === 0 || record.taskId.length > 128) {
    throw new InputValidationError("Task ID is invalid.");
  }
  let answers: Array<{ questionId: string; answer: string }>;
  if (record.answers !== undefined) {
    if (!Array.isArray(record.answers) || record.answers.length === 0 || record.answers.length > 10) {
      throw new InputValidationError("Answers must be a short non-empty list.");
    }
    answers = record.answers.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new InputValidationError("Answer item is invalid.");
      }
      const answerRecord = item as Record<string, unknown>;
      return {
        questionId: requiredText(answerRecord.questionId, "Question ID", 128),
        answer: requiredText(answerRecord.answer, "Answer", 4_000),
      };
    });
  } else {
    answers = [{
      questionId: requiredText(record.questionId, "Question ID", 128),
      answer: requiredText(record.answer, "Answer", 4_000),
    }];
  }
  return {
    taskId: record.taskId.trim(),
    answers,
    images: optionalImages(record.images),
  };
}

function parseTaskListInput(value: unknown): { projectId: string; limit: number | null } {
  if (typeof value === "string") return { projectId: parseProjectId(value), limit: 20 };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("Expected a project ID or task list input.");
  }
  const record = value as Record<string, unknown>;
  const rawLimit = record.limit;
  if (rawLimit === null) return { projectId: parseProjectId(record.projectId), limit: null };
  if (rawLimit === undefined) return { projectId: parseProjectId(record.projectId), limit: 20 };
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500) {
    throw new InputValidationError("Task list limit is invalid.");
  }
  return { projectId: parseProjectId(record.projectId), limit: rawLimit };
}

function parseTaskId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new InputValidationError("Task ID is invalid.");
  }
  return value.trim();
}

function parseDraftUpdate(value: unknown): { taskId: string; input: BrainstormDraft } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("Expected a draft update.");
  }
  const record = value as Record<string, unknown>;
  return {
    taskId: parseTaskId(record.taskId),
    input: parseBrainstormDraft(record.input),
  };
}

function canWaitForQuestions(status: TaskSummary["status"]): boolean {
  return status === "DESIGN_REVIEW" || status === "DRAFT" || status === "WAITING_USER";
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Claude brainstorm failed.";
}

function failureCode(input: { code?: string; summary: string; rateLimitType?: string }): string | undefined {
  if (input.code) return input.code;
  if (input.rateLimitType) return input.rateLimitType;
  const text = input.summary.toLowerCase();
  if (text.includes("max_turns") || text.includes("max turns") || text.includes("maximum number of turns")) return "max_turns";
  if (text.includes("five-hour") || text.includes("five hour") || text.includes("5h")) return "five_hour";
  if (text.includes("rate limit")) return "rate_limit";
  return undefined;
}

function isRecoverableBrainstormFailure(input: { classification?: FailureClass; code?: string; summary: string }): boolean {
  if (input.classification === "AUTH" || input.classification === "CANCELLED") return false;
  const text = `${input.code ?? ""} ${input.summary}`.toLowerCase();
  if (text.includes("max_turns") || text.includes("max turns") || text.includes("maximum number of turns")) return true;
  if (text.includes("context") || text.includes("too long") || text.includes("token")) return true;
  if (text.includes("timeout") || text.includes("interrupted") || text.includes("aborted")) return true;
  return input.classification === "RATE_LIMIT" || input.classification === "PROVIDER" || input.classification === "UNKNOWN";
}

function autoResumeAt(input: { classification?: FailureClass; code?: string; rateLimitType?: string; rateLimitResetAt?: string }): string | undefined {
  if (input.classification !== "RATE_LIMIT") return undefined;
  if (input.rateLimitType !== "five_hour" && input.code !== "five_hour") return undefined;
  if (!input.rateLimitResetAt) return undefined;
  const resetTime = Date.parse(input.rateLimitResetAt);
  if (Number.isNaN(resetTime)) return undefined;
  return new Date(resetTime + 30_000).toISOString();
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function cleanQuestionText(text: string): string {
  return text
    .replace(/[*_`]/g, "")
    .replace(/\s+$/g, "")
    .replace(/[:;]+$/g, "")
    .trim();
}

function isQuestionMarker(line: string): boolean {
  return /^\**\s*pergunta(?:\s+(?:de\s+teste\s+)?#?\d+)?(?:\s*\(.+\))?\s*:\**\s*$/i.test(line.trim());
}

function revisionPrompt(task: Task, feedback: string): string {
  return [
    "Continue the Superpowers brainstorm/design workflow for this Anubis task.",
    "Treat the user's feedback below as the next answer/revision request.",
    "Do not modify repository files. Keep the spec inside this response as Markdown.",
    "Return the revised spec as the final answer.",
    "",
    `Task #${task.taskNumber}: ${task.title}`,
    "",
    "User feedback / answer:",
    feedback,
  ].join("\n");
}

function retryBrainstormPrompt(task: Task): string {
  return [
    "Continue the Superpowers brainstorm/design workflow for this Anubis task.",
    "The previous Anubis capture failed while recording provider events, so continue from the existing Claude session.",
    "Do not modify repository files. Keep the spec inside this response as Markdown.",
    "If you had already asked questions, repeat the pending questions clearly. If the design is ready, return the spec.",
    "",
    `Task #${task.taskNumber}: ${task.title}`,
    "",
    "Original task description:",
    task.description,
  ].join("\n");
}

function attachmentSummary(images: ConversationImageAttachment[]): string {
  if (images.length === 0) return "";
  return [
    "",
    "Attached images:",
    ...images.map((image) => `- ${image.name} (${image.mediaType}, ${Math.round(image.sizeBytes / 1024)} KB)`),
  ].join("\n");
}

function draftBrainstormPrompt(task: Task): string {
  return superpowersBrainstormPrompt({
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    model: task.model,
    effort: task.effort,
  });
}

function taskInitialPrompt(events: AgentEventEnvelope[]): string {
  const event = events.find((candidate) => candidate.payload.type === "user_message" && candidate.payload.kind === "initial_prompt");
  return event?.payload.type === "user_message" ? event.payload.text.trim() : "";
}

function taskFinalSummary(events: AgentEventEnvelope[], spec: TaskSpec | null): string {
  const specText = spec?.contentMarkdown.trim();
  const completed = [...events].reverse().find((event) => {
    if (event.payload.type !== "completed" || !event.payload.summary?.trim()) return false;
    return event.payload.summary.trim() !== specText;
  });
  if (completed?.payload.type === "completed" && completed.payload.summary?.trim()) {
    return completed.payload.summary.trim();
  }
  const message = [...events].reverse().find((event) => event.payload.type === "message_completed" && event.payload.text?.trim());
  if (message?.payload.type === "message_completed" && message.payload.text?.trim()) {
    return message.payload.text.trim();
  }
  return "";
}

function taskContextBlock(task: TaskSummary, spec: TaskSpec | null, events: AgentEventEnvelope[]): string {
  const initialPrompt = taskInitialPrompt(events);
  const finalSummary = taskFinalSummary(events, spec);
  return [
    `### Task #${task.taskNumber}: ${task.title}`,
    `Status: ${task.status}`,
    task.latestEventText ? `Latest activity: ${task.latestEventText}` : "",
    initialPrompt ? ["Initial prompt:", initialPrompt.slice(0, 3_000)].join("\n") : "",
    spec?.contentMarkdown ? ["Stored spec:", spec.contentMarkdown.slice(0, 5_000)].join("\n") : "",
    finalSummary ? ["Final summary:", finalSummary.slice(0, 4_000)].join("\n") : "",
  ].filter(Boolean).join("\n");
}

function extractSectionQuestions(lines: string[]): AgentQuestion[] {
  const start = lines.findIndex((line) => /^#{1,6}\s*(questions|perguntas)\s*$/i.test(line.trim()));
  if (start === -1) return [];

  const questions: AgentQuestion[] = [];
  let current: { prompt: string; options: string[] } | null = null;

  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+\S/.test(trimmed)) break;
    const numbered = trimmed.match(/^\d+[\).\s-]+(.+)$/);
    if (numbered?.[1]) {
      if (current) questions.push({ id: randomUUID(), prompt: current.prompt, options: current.options });
      current = { prompt: cleanQuestionText(numbered[1]), options: [] };
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet?.[1] && current) current.options.push(cleanQuestionText(bullet[1]));
  }
  if (current) questions.push({ id: randomUUID(), prompt: current.prompt, options: current.options });
  return questions;
}

function extractPromptedQuestions(lines: string[]): AgentQuestion[] {
  const questions: AgentQuestion[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!isQuestionMarker(lines[index] ?? "")) continue;

    const promptParts: string[] = [];
    const options: string[] = [];
    let currentOption = "";
    let cursor = index + 1;

    for (; cursor < lines.length; cursor += 1) {
      const raw = lines[cursor] ?? "";
      const trimmed = raw.trim();
      if (/^#{1,6}\s+\S/.test(trimmed) || /^-{3,}$/.test(trimmed)) break;
      if (!trimmed) continue;

      if (isQuestionMarker(trimmed)) break;

      const option = trimmed.match(/^[-*]?\s*([a-zA-Z])[\).]\s+(.+)$/);
      if (option?.[2]) {
        if (currentOption) options.push(cleanQuestionText(currentOption));
        currentOption = option[2];
        continue;
      }

      if (currentOption) {
        currentOption = `${currentOption} ${trimmed}`;
      } else {
        promptParts.push(trimmed);
      }
    }

    if (currentOption) options.push(cleanQuestionText(currentOption));
    const prompt = cleanQuestionText(promptParts.join(" "));
    if (prompt) questions.push({ id: randomUUID(), prompt, options });
    index = Math.max(index, cursor - 1);
  }

  return questions;
}

function extractQuestions(markdown: string): AgentQuestion[] {
  const lines = markdown.split(/\r?\n/);
  return [...extractSectionQuestions(lines), ...extractPromptedQuestions(lines)].slice(0, 10);
}

export class BrainstormService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly journal: AgentJournalRepository,
    private readonly providers: ProviderRegistry,
    private readonly notifications?: NotificationSink,
    private readonly settings?: TurnBudgetSettings,
  ) {}

  private brainstormMaxTurns(previousRuns: number): number | undefined {
    if (this.settings && !this.settings.get().controlledMaxTurns) return undefined;
    return quadraticTurnBudget(brainstormBaseMaxTurns, previousRuns);
  }

  private brainstormMaxTurnsOption(previousRuns: number): { maxTurns?: number } {
    const maxTurns = this.brainstormMaxTurns(previousRuns);
    return maxTurns ? { maxTurns } : {};
  }

  createDraft(inputValue: unknown): TaskSummary {
    const input = parseBrainstormDraft(inputValue);
    const model = input.model ?? "default";
    const effort = input.effort ?? "default";
    const project = this.projects.get(input.projectId);
    const now = new Date().toISOString();
    const task = this.journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: this.journal.nextTaskNumber(project.id),
      title: input.title,
      description: input.description,
      status: "DRAFT",
      provider: "claude",
      workflow: "superpowers",
      model,
      effort,
      position: 0,
      now,
    });
    if (input.contextTaskIds && input.contextTaskIds.length > 0) {
      this.journal.replaceTaskContextLinks(task.id, input.contextTaskIds, now);
    }
    const summary = this.journal.listTasksForProject(project.id, null).find((candidate) => candidate.id === task.id);
    if (!summary) throw new InputValidationError("Draft task could not be loaded.");
    return summary;
  }

  updateDraft(inputValue: unknown): TaskSummary {
    const { taskId, input } = parseDraftUpdate(inputValue);
    const existing = this.journal.getTask(taskId);
    if (existing.status !== "DRAFT") {
      throw new InputValidationError("Only draft tasks can be edited.");
    }
    if (existing.projectId !== input.projectId) {
      throw new InputValidationError("Draft task does not belong to the selected project.");
    }
    const project = this.projects.get(input.projectId);
    const model = input.model ?? "default";
    const effort = input.effort ?? "default";
    const now = new Date().toISOString();
    const task = this.journal.updateDraftTask(taskId, {
      title: input.title,
      description: input.description,
      model,
      effort,
      updatedAt: now,
    });
    this.journal.replaceTaskContextLinks(task.id, input.contextTaskIds ?? [], now);
    const summary = this.journal.listTasksForProject(project.id, null).find((candidate) => candidate.id === task.id);
    if (!summary) throw new InputValidationError("Draft task could not be loaded.");
    return summary;
  }

  async start(inputValue: unknown): Promise<BrainstormResult> {
    const input = parseBrainstormDraft(inputValue);
    const model = input.model ?? "default";
    const effort = input.effort ?? "default";
    const project = this.projects.get(input.projectId);
    const provider = this.providers.get("claude");
    if (!provider) throw new ProviderUnavailableError("Claude provider is not registered.");
    const memoryContext = this.buildMemoryContext(project.id, input.includeProjectMemory ?? true, input.contextTaskIds ?? []);

    const now = new Date().toISOString();
    const started = await provider.startSession({
      cwd: project.path,
      prompt: promptWithImages(
        `${superpowersBrainstormPrompt(input)}${memoryContext}${attachmentSummary(input.images ?? [])}`,
        input.images ?? [],
      ),
      metadata: { purpose: "brainstorm", projectId: project.id },
      ...this.brainstormMaxTurnsOption(0),
      model,
      effort,
    });

    let task: Task;
    let session: AgentSession;
    try {
      task = this.journal.createTask({
        id: randomUUID(),
        projectId: project.id,
        taskNumber: this.journal.nextTaskNumber(project.id),
        title: input.title,
        description: input.description,
        status: "BRAINSTORMING",
        provider: "claude",
        workflow: "superpowers",
        model,
        effort,
        position: 0,
        now,
      });
      session = this.journal.createSession({
        id: randomUUID(),
        taskId: task.id,
        provider: "claude",
        providerSessionId: started.session.providerSessionId,
        type: "BRAINSTORM",
        status: "ACTIVE",
        createdAt: now,
      });
      if (input.contextTaskIds && input.contextTaskIds.length > 0) {
        this.journal.replaceTaskContextLinks(task.id, input.contextTaskIds, now);
      }
      this.appendUserMessage({
        projectId: project.id,
        taskId: task.id,
        sessionId: session.id,
        kind: "initial_prompt",
        text: initialUserPrompt(input),
        attachments: userAttachments(input.images),
      });
    } catch (error) {
      await provider.cancel(started.session, "Failed to persist brainstorm metadata.");
      throw error;
    }

    const result = await this.captureSessionEvents({ provider, projectId: project.id, task, session });
    const questions = result.failed ? [] : this.appendQuestions(project.id, task.id, session.id, result.nextSequence, result.summary);
    const status = result.failed
      ? isRecoverableBrainstormFailure(result) ? "READY_TO_RESUME" : "FAILED"
      : questions.length > 0 ? "WAITING_USER" : "DESIGN_REVIEW";
    if (result.failed) {
      const scheduledAutoResumeAt = status === "READY_TO_RESUME" ? autoResumeAt(result) : undefined;
      const code = failureCode(result);
      this.journal.completeTaskExecution(task.id, status, new Date().toISOString(), {
        ...(scheduledAutoResumeAt ? { autoResumeAt: scheduledAutoResumeAt } : {}),
        ...(code ? { failureCode: code } : {}),
      });
    } else {
      this.journal.updateTaskStatus(task.id, status);
    }
    this.journal.updateSessionStatus(session.id, "ENDED");
    const spec = result.failed || questions.length > 0 ? undefined : this.createSpec(task.id, session.id, result.summary);
    this.notifyBrainstormResult(project.name, task, status, questions.length, result.summary);

    return {
      taskId: task.id,
      sessionId: session.id,
      providerSessionId: started.session.providerSessionId,
      eventCount: this.journal.countEventsForSession(session.id),
      summary: result.summary,
      ...(spec ? { spec } : {}),
    };
  }

  async revise(
    inputValue: unknown,
    userMessageKind: "revision_feedback" | "question_answer" = "revision_feedback",
  ): Promise<BrainstormResult> {
    const input = parseBrainstormRevision(inputValue);
    const task = this.journal.getTask(input.taskId);
    if (task.status !== "DESIGN_REVIEW" && task.status !== "DRAFT" && task.status !== "WAITING_USER") {
      throw new InputValidationError("Only draft, waiting, or design review tasks can be revised.");
    }
    const project = this.projects.get(task.projectId);
    const previousSession = this.journal.getLatestSessionForTask(task.id, "BRAINSTORM");
    if (!previousSession?.providerSessionId) {
      throw new InputValidationError("Task has no brainstorm session to revise.");
    }
    const provider = this.providers.get("claude");
    if (!provider) throw new ProviderUnavailableError("Claude provider is not registered.");
    const previousRuns = this.journal.countSessionsForTask(task.id, "BRAINSTORM");

    const resumed = await provider.resumeSession({
      session: { provider: "claude", providerSessionId: previousSession.providerSessionId },
      cwd: project.path,
      prompt: promptWithImages(`${revisionPrompt(task, input.feedback)}${attachmentSummary(input.images ?? [])}`, input.images ?? []),
      ...this.brainstormMaxTurnsOption(previousRuns),
      model: task.model,
      effort: task.effort,
    });
    const now = new Date().toISOString();
    const session = this.journal.createSession({
      id: randomUUID(),
      taskId: task.id,
      provider: "claude",
      providerSessionId: resumed.session.providerSessionId,
      type: "BRAINSTORM",
      status: "ACTIVE",
      createdAt: now,
    });
    this.journal.updateTaskStatus(task.id, "BRAINSTORMING", now);
    this.appendUserMessage({
      projectId: project.id,
      taskId: task.id,
      sessionId: session.id,
      kind: userMessageKind,
      text: input.feedback,
      attachments: userAttachments(input.images),
    });

    const result = await this.captureSessionEvents({ provider, projectId: project.id, task, session });
    const questions = result.failed ? [] : this.appendQuestions(project.id, task.id, session.id, result.nextSequence, result.summary);
    const status = result.failed
      ? isRecoverableBrainstormFailure(result) ? "READY_TO_RESUME" : "FAILED"
      : questions.length > 0 ? "WAITING_USER" : "DESIGN_REVIEW";
    if (result.failed) {
      const scheduledAutoResumeAt = status === "READY_TO_RESUME" ? autoResumeAt(result) : undefined;
      const code = failureCode(result);
      this.journal.completeTaskExecution(task.id, status, new Date().toISOString(), {
        ...(scheduledAutoResumeAt ? { autoResumeAt: scheduledAutoResumeAt } : {}),
        ...(code ? { failureCode: code } : {}),
      });
    } else {
      this.journal.updateTaskStatus(task.id, status);
    }
    this.journal.updateSessionStatus(session.id, "ENDED");
    const spec = result.failed || questions.length > 0 ? undefined : this.createSpec(task.id, session.id, result.summary);
    this.notifyBrainstormResult(project.name, task, status, questions.length, result.summary);

    return {
      taskId: task.id,
      sessionId: session.id,
      providerSessionId: resumed.session.providerSessionId,
      eventCount: this.journal.countEventsForSession(session.id),
      summary: result.summary,
      ...(spec ? { spec } : {}),
    };
  }

  async retry(taskIdValue: unknown): Promise<BrainstormResult> {
    const taskId = parseTaskId(taskIdValue);
    const task = this.journal.getTask(taskId);
    if (task.status !== "FAILED" && task.status !== "DRAFT" && task.status !== "READY_TO_RESUME") {
      throw new InputValidationError("Only draft, failed, or resumable brainstorm tasks can be started.");
    }
    const project = this.projects.get(task.projectId);
    const previousSession = this.journal.getLatestSessionForTask(task.id, "BRAINSTORM");
    if (task.status === "FAILED" && !previousSession?.providerSessionId) {
      throw new InputValidationError("Task has no Claude brainstorm session to retry.");
    }
    const provider = this.providers.get("claude");
    if (!provider) throw new ProviderUnavailableError("Claude provider is not registered.");
    const previousRuns = this.journal.countSessionsForTask(task.id, "BRAINSTORM");
    const draftContextTaskIds = task.status === "DRAFT" && !previousSession?.providerSessionId
      ? this.journal.listTaskContextIds(task.id)
      : [];
    const draftMemoryContext = task.status === "DRAFT" && !previousSession?.providerSessionId
      ? this.buildMemoryContext(project.id, true, draftContextTaskIds)
      : "";

    const started = task.status === "DRAFT" && !previousSession?.providerSessionId
      ? await provider.startSession({
          cwd: project.path,
          prompt: `${draftBrainstormPrompt(task)}${draftMemoryContext}`,
          metadata: { purpose: "brainstorm", projectId: project.id, taskId: task.id },
          ...this.brainstormMaxTurnsOption(previousRuns),
          model: task.model,
          effort: task.effort,
        })
      : await provider.resumeSession({
          session: { provider: "claude", providerSessionId: previousSession?.providerSessionId ?? "" },
          cwd: project.path,
          prompt: retryBrainstormPrompt(task),
          ...this.brainstormMaxTurnsOption(previousRuns),
          model: task.model,
          effort: task.effort,
        });
    const now = new Date().toISOString();
    const session = this.journal.createSession({
      id: randomUUID(),
      taskId: task.id,
      provider: "claude",
      providerSessionId: started.session.providerSessionId,
      type: "BRAINSTORM",
      status: "ACTIVE",
      createdAt: now,
    });
    this.journal.updateTaskStatus(task.id, "BRAINSTORMING", now);
    this.appendUserMessage({
      projectId: project.id,
      taskId: task.id,
      sessionId: session.id,
      kind: task.status === "DRAFT" && !previousSession?.providerSessionId ? "initial_prompt" : "retry",
      text: task.status === "DRAFT" && !previousSession?.providerSessionId
        ? initialUserPrompt({
            projectId: project.id,
            title: task.title,
            description: task.description,
            model: task.model,
            effort: task.effort,
            includeProjectMemory: true,
            contextTaskIds: draftContextTaskIds,
          })
        : retryBrainstormPrompt(task),
    });

    const result = await this.captureSessionEvents({ provider, projectId: project.id, task, session });
    const questions = result.failed ? [] : this.appendQuestions(project.id, task.id, session.id, result.nextSequence, result.summary);
    const status = result.failed
      ? isRecoverableBrainstormFailure(result) ? "READY_TO_RESUME" : "FAILED"
      : questions.length > 0 ? "WAITING_USER" : "DESIGN_REVIEW";
    if (result.failed) {
      const scheduledAutoResumeAt = status === "READY_TO_RESUME" ? autoResumeAt(result) : undefined;
      const code = failureCode(result);
      this.journal.completeTaskExecution(task.id, status, new Date().toISOString(), {
        ...(scheduledAutoResumeAt ? { autoResumeAt: scheduledAutoResumeAt } : {}),
        ...(code ? { failureCode: code } : {}),
      });
    } else {
      this.journal.updateTaskStatus(task.id, status);
    }
    this.journal.updateSessionStatus(session.id, "ENDED");
    const spec = result.failed || questions.length > 0 ? undefined : this.createSpec(task.id, session.id, result.summary);
    this.notifyBrainstormResult(project.name, task, status, questions.length, result.summary);

    return {
      taskId: task.id,
      sessionId: session.id,
      providerSessionId: started.session.providerSessionId,
      eventCount: this.journal.countEventsForSession(session.id),
      summary: result.summary,
      ...(spec ? { spec } : {}),
    };
  }

  private appendUserMessage(input: {
    projectId: string;
    taskId: string;
    sessionId: string;
    kind: "initial_prompt" | "revision_feedback" | "question_answer" | "retry";
    text: string;
    attachments?: Array<{ name: string; mediaType: string; sizeBytes: number }> | undefined;
  }): void {
    this.journal.appendEvent({
      eventId: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      projectId: input.projectId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      sequence: this.journal.countEventsForSession(input.sessionId) + 1,
      persistence: "DURABLE",
      payload: {
        type: "user_message",
        kind: input.kind,
        text: input.text,
        ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      },
    });
  }

  private async captureSessionEvents(input: {
    provider: AgentProvider;
    projectId: string;
    task: Task;
    session: AgentSession;
  }): Promise<{
    failed: boolean;
    summary: string;
    nextSequence: number;
    classification?: FailureClass;
    code?: string;
    rateLimitType?: string;
    rateLimitResetAt?: string;
  }> {
    let sequence = this.journal.countEventsForSession(input.session.id);
    let summary = "";
    let lastMessageText = "";
    let failed = false;
    let classification: FailureClass | undefined;
    let code: string | undefined;
    let rateLimitType: string | undefined;
    let rateLimitResetAt: string | undefined;

    const appendEvent = (event: AgentEvent): void => {
      sequence += 1;
      if (event.type === "completed" && event.summary) summary = event.summary;
      if (event.type === "failed") {
        failed = true;
        summary = event.error.message || summary;
        classification = event.classification;
        code = event.error.code;
      }
      if (event.type === "rate_limit_updated") {
        rateLimitType = event.rateLimitType;
        rateLimitResetAt = event.resetsAt;
      }
      if (event.type === "session_finished" && event.outcome !== "COMPLETED") failed = true;
      this.journal.appendEvent({
        eventId: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        projectId: input.projectId,
        taskId: input.task.id,
        sessionId: input.session.id,
        sequence,
        persistence: "DURABLE",
        payload: event,
      });
    };

    try {
      const providerSession: ProviderSessionRef = {
        provider: input.session.provider,
        providerSessionId: input.session.providerSessionId ?? "",
      };
      for await (const event of input.provider.events(providerSession, new AbortController().signal)) {
        if (event.type === "message_completed" && event.text) lastMessageText = event.text;
        if (event.type === "completed" && event.summary && event.summary === lastMessageText) {
          summary = event.summary;
          continue;
        }
        appendEvent(event);
      }
    } catch (error) {
      failed = true;
      summary = providerErrorMessage(error);
      classification = "PROVIDER";
      appendEvent({
        type: "failed",
        classification: "PROVIDER",
        error: { message: summary },
      });
      appendEvent({ type: "session_finished", outcome: "FAILED" });
    }
    return {
      failed,
      summary: summary || lastMessageText,
      nextSequence: sequence + 1,
      ...(classification ? { classification } : {}),
      ...(code ? { code } : {}),
      ...(rateLimitType ? { rateLimitType } : {}),
      ...(rateLimitResetAt ? { rateLimitResetAt } : {}),
    };
  }

  listSessionEvents(sessionIdInput: unknown): AgentEventEnvelope[] {
    if (typeof sessionIdInput !== "string" || sessionIdInput.trim().length === 0 || sessionIdInput.length > 128) {
      throw new InputValidationError("Session ID is invalid.");
    }
    return this.journal.listEventsForSession(sessionIdInput.trim());
  }

  listTaskEvents(taskIdInput: unknown): AgentEventEnvelope[] {
    if (typeof taskIdInput !== "string" || taskIdInput.trim().length === 0 || taskIdInput.length > 128) {
      throw new InputValidationError("Task ID is invalid.");
    }
    return this.journal.listEventsForTask(taskIdInput.trim());
  }

  listTasks(projectIdInput: unknown): TaskSummary[] {
    const input = parseTaskListInput(projectIdInput);
    const tasks = this.journal.listTasksForProject(input.projectId, input.limit);
    let rediscoveredQuestions = false;
    const hydrated = tasks.map((task) => {
      const pendingQuestions = this.discoverPendingQuestions(task);
      if (pendingQuestions.length > 0 && task.status !== "WAITING_USER") rediscoveredQuestions = true;
      return {
        ...task,
        ...(pendingQuestions.length > 0 ? { status: "WAITING_USER" as const } : {}),
        pendingQuestions,
      };
    });
    if (!rediscoveredQuestions) return hydrated;
    return this.journal.listTasksForProject(input.projectId, input.limit).map((task) => ({
      ...task,
      pendingQuestions: this.pendingQuestions(task.id),
    }));
  }

  async answerQuestion(inputValue: unknown): Promise<BrainstormResult> {
    const input = parseQuestionAnswer(inputValue);
    const pendingById = new Map(this.pendingQuestions(input.taskId).map((question) => [question.id, question]));
    const answers = input.answers.map((answer) => {
      const question = pendingById.get(answer.questionId);
      if (!question) throw new InputValidationError("Question is not waiting for an answer.");
      return { question, answer: answer.answer };
    });
    const latestSession = this.journal.getLatestSessionForTask(input.taskId, "BRAINSTORM");
    if (!latestSession) throw new InputValidationError("Task has no brainstorm session to answer.");
    const task = this.journal.getTask(input.taskId);
    answers.forEach(({ question }) => {
      this.journal.appendEvent({
        eventId: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        projectId: task.projectId,
        taskId: input.taskId,
        sessionId: latestSession.id,
        sequence: this.nextEventSequence(input.taskId),
        persistence: "DURABLE",
        payload: { type: "question_answered", questionId: question.id },
      });
    });
    return this.revise({
      taskId: input.taskId,
      feedback: answers
        .map(({ question, answer }) => `Answer to "${question.prompt}": ${answer}`)
        .join("\n\n"),
      images: input.images,
    }, "question_answer");
  }

  getLatestSpec(taskIdInput: unknown): TaskSpec | null {
    if (typeof taskIdInput !== "string" || taskIdInput.trim().length === 0 || taskIdInput.length > 128) {
      throw new InputValidationError("Task ID is invalid.");
    }
    return this.journal.getLatestSpec(taskIdInput.trim());
  }

  getProjectStats(projectIdInput: unknown): ProjectStats {
    const projectId = parseProjectId(projectIdInput);
    this.listTasks({ projectId, limit: null });
    return this.journal.getProjectStats(projectId);
  }

  getProjectMemory(projectIdInput: unknown): ProjectMemory {
    const projectId = parseProjectId(projectIdInput);
    this.projects.get(projectId);
    return this.journal.getProjectMemory(projectId);
  }

  updateProjectMemory(inputValue: unknown): ProjectMemory {
    const input = parseProjectMemoryUpdate(inputValue);
    this.projects.get(input.projectId);
    return this.journal.updateProjectMemory(input.projectId, input.contentMarkdown);
  }

  reviewTask(inputValue: unknown): TaskSummary {
    const input = parseReviewDecision(inputValue);
    const task = this.journal.getTask(input.taskId);
    if (task.status !== "DESIGN_REVIEW") {
      throw new InputValidationError("Only tasks in design review can be reviewed.");
    }
    if (input.decision === "approve") this.journal.approveLatestSpec(task.id);
    this.journal.updateTaskStatus(task.id, input.decision === "approve" ? "QUEUED" : "DRAFT");
    const updated = this.journal.listTasksForProject(task.projectId).find((candidate) => candidate.id === task.id);
    if (!updated) throw new InputValidationError("Reviewed task could not be loaded.");
    return updated;
  }

  private createSpec(taskId: string, sessionId: string, content: string): TaskSpec | undefined {
    const normalized = content.trim();
    if (!normalized) return undefined;
    return this.journal.createTaskSpec({
      id: randomUUID(),
      taskId,
      contentMarkdown: normalized,
      sha256: sha256(normalized),
      sourceSessionId: sessionId,
      createdAt: new Date().toISOString(),
    });
  }

  private notifyBrainstormResult(
    projectName: string,
    task: Task,
    status: "FAILED" | "READY_TO_RESUME" | "WAITING_USER" | "DESIGN_REVIEW",
    questionCount: number,
    summary: string,
  ): void {
    if (status === "WAITING_USER") this.notifications?.brainstormNeedsAnswer(projectName, task, questionCount);
    if (status === "DESIGN_REVIEW") this.notifications?.brainstormReadyForReview(projectName, task);
    if (status === "FAILED" || status === "READY_TO_RESUME") this.notifications?.brainstormFailed(projectName, task, summary);
  }

  private appendQuestions(
    projectId: string,
    taskId: string,
    sessionId: string,
    firstSequence: number,
    markdown: string,
  ): AgentQuestion[] {
    const questions = extractQuestions(markdown);
    questions.forEach((question, index) => {
      this.journal.appendEvent({
        eventId: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        projectId,
        taskId,
        sessionId,
        sequence: firstSequence + index,
        persistence: "DURABLE",
        payload: { type: "question_asked", question },
      });
    });
    return questions;
  }

  private buildMemoryContext(projectId: string, includeProjectMemory: boolean, contextTaskIds: string[]): string {
    const sections: string[] = [];
    if (includeProjectMemory) {
      const memory = this.journal.getProjectMemory(projectId).contentMarkdown.trim();
      if (memory) {
        sections.push(["Project memory:", memory].join("\n"));
      }
    }
    if (contextTaskIds.length > 0) {
      const tasks = this.journal.listTasksForProject(projectId, null);
      const tasksById = new Map(tasks.map((task) => [task.id, task]));
      const blocks = contextTaskIds.map((taskId) => {
        const task = tasksById.get(taskId);
        if (!task) throw new InputValidationError("Context task does not belong to this project.");
        return taskContextBlock(task, this.journal.getLatestSpec(task.id), this.journal.listEventsForTask(task.id));
      });
      sections.push(["Selected task context:", ...blocks].join("\n\n"));
    }
    if (sections.length === 0) return "";
    return ["", "Additional Anubis context:", ...sections].join("\n\n");
  }

  private pendingQuestions(taskId: string): AgentQuestion[] {
    const events = this.journal.listEventsForTask(taskId);
    const answered = new Set(
      events
        .filter((event) => event.payload.type === "question_answered")
        .map((event) => (event.payload.type === "question_answered" ? event.payload.questionId : "")),
    );
    return events
      .filter((event) => event.payload.type === "question_asked")
      .map((event) => (event.payload.type === "question_asked" ? event.payload.question : null))
      .filter((question): question is AgentQuestion => question !== null && !answered.has(question.id));
  }

  private discoverPendingQuestions(task: TaskSummary): AgentQuestion[] {
    if (!canWaitForQuestions(task.status)) return [];
    const pending = this.pendingQuestions(task.id);
    if (pending.length > 0) return pending;

    const events = this.journal.listEventsForTask(task.id);
    if (events.some((event) => event.payload.type === "question_asked")) return [];

    const latestSession = this.journal.getLatestSessionForTask(task.id, "BRAINSTORM");
    if (!latestSession) return [];

    const latestSpec = this.journal.getLatestSpec(task.id);
    const source = latestSpec?.contentMarkdown ?? this.latestReadableEventText(events);
    if (!source) return [];

    const discovered = this.appendQuestions(task.projectId, task.id, latestSession.id, this.nextEventSequence(task.id), source);
    if (discovered.length === 0) return [];
    this.journal.updateTaskStatus(task.id, "WAITING_USER");
    return this.pendingQuestions(task.id);
  }

  private latestReadableEventText(events: AgentEventEnvelope[]): string {
    for (const event of [...events].reverse()) {
      if (event.payload.type === "completed" && event.payload.summary) return event.payload.summary;
      if (event.payload.type === "message_completed" && event.payload.text) return event.payload.text;
    }
    return "";
  }

  private nextEventSequence(taskId: string): number {
    const latestSession = this.journal.getLatestSessionForTask(taskId, "BRAINSTORM");
    if (!latestSession) return 1;
    const events = this.journal.listEventsForSession(latestSession.id);
    return Math.max(0, ...events.map((event) => event.sequence)) + 1;
  }
}
