import { createHash, randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventEnvelope, AgentQuestion } from "../../shared/agent-events";
import type {
  BrainstormDraft,
  BrainstormResult,
  BrainstormRevisionInput,
  QuestionAnswerInput,
  ReviewDecisionInput,
  TaskSpec,
  TaskSummary,
} from "../../shared/app";
import { InputValidationError, parseProjectId } from "../../shared/projects";
import type { AgentSession, Task } from "../../shared/tasks";
import { AgentJournalRepository } from "../repositories/agent-journal-repository";
import { ProjectRepository } from "../repositories/project-repository";
import type { AgentProvider, ProviderSessionRef } from "../providers/agent-provider";
import { ProviderUnavailableError } from "../providers/agent-provider";
import { ProviderRegistry } from "../providers/provider-registry";
import { superpowersBrainstormPrompt } from "../workflows/superpowers-workflow";

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new InputValidationError(`${field} must be text.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new InputValidationError(`${field} must contain between 1 and ${maximum} characters.`);
  }
  if (normalized.includes("\0")) throw new InputValidationError(`${field} contains an invalid character.`);
  return normalized;
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
  };
}

function parseQuestionAnswer(value: unknown): QuestionAnswerInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("Expected an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.taskId !== "string" || record.taskId.trim().length === 0 || record.taskId.length > 128) {
    throw new InputValidationError("Task ID is invalid.");
  }
  if (typeof record.questionId !== "string" || record.questionId.trim().length === 0 || record.questionId.length > 128) {
    throw new InputValidationError("Question ID is invalid.");
  }
  return {
    taskId: record.taskId.trim(),
    questionId: record.questionId.trim(),
    answer: requiredText(record.answer, "Answer", 4_000),
  };
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Claude brainstorm failed.";
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
  ) {}

  async start(inputValue: unknown): Promise<BrainstormResult> {
    const input = parseBrainstormDraft(inputValue);
    const project = this.projects.get(input.projectId);
    const provider = this.providers.get("claude");
    if (!provider) throw new ProviderUnavailableError("Claude provider is not registered.");

    const now = new Date().toISOString();
    const started = await provider.startSession({
      cwd: project.path,
      prompt: superpowersBrainstormPrompt(input),
      metadata: { purpose: "brainstorm", projectId: project.id },
      maxTurns: 6,
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
    } catch (error) {
      await provider.cancel(started.session, "Failed to persist brainstorm metadata.");
      throw error;
    }

    const result = await this.captureSessionEvents({ provider, projectId: project.id, task, session });
    const questions = result.failed ? [] : this.appendQuestions(project.id, task.id, session.id, result.nextSequence, result.summary);
    const status = result.failed ? "FAILED" : questions.length > 0 ? "WAITING_USER" : "DESIGN_REVIEW";
    this.journal.updateTaskStatus(task.id, status);
    this.journal.updateSessionStatus(session.id, "ENDED");
    const spec = result.failed || questions.length > 0 ? undefined : this.createSpec(task.id, session.id, result.summary);

    return {
      taskId: task.id,
      sessionId: session.id,
      providerSessionId: started.session.providerSessionId,
      eventCount: this.journal.countEventsForSession(session.id),
      summary: result.summary,
      ...(spec ? { spec } : {}),
    };
  }

  async revise(inputValue: unknown): Promise<BrainstormResult> {
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

    const resumed = await provider.resumeSession({
      session: { provider: "claude", providerSessionId: previousSession.providerSessionId },
      cwd: project.path,
      prompt: revisionPrompt(task, input.feedback),
      maxTurns: 6,
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

    const result = await this.captureSessionEvents({ provider, projectId: project.id, task, session });
    const questions = result.failed ? [] : this.appendQuestions(project.id, task.id, session.id, result.nextSequence, result.summary);
    const status = result.failed ? "FAILED" : questions.length > 0 ? "WAITING_USER" : "DESIGN_REVIEW";
    this.journal.updateTaskStatus(task.id, status);
    this.journal.updateSessionStatus(session.id, "ENDED");
    const spec = result.failed || questions.length > 0 ? undefined : this.createSpec(task.id, session.id, result.summary);

    return {
      taskId: task.id,
      sessionId: session.id,
      providerSessionId: resumed.session.providerSessionId,
      eventCount: this.journal.countEventsForSession(session.id),
      summary: result.summary,
      ...(spec ? { spec } : {}),
    };
  }

  private async captureSessionEvents(input: {
    provider: AgentProvider;
    projectId: string;
    task: Task;
    session: AgentSession;
  }): Promise<{ failed: boolean; summary: string; nextSequence: number }> {
    let sequence = 0;
    let summary = "";
    let lastMessageText = "";
    let failed = false;

    const appendEvent = (event: AgentEvent): void => {
      sequence += 1;
      if (event.type === "completed" && event.summary) summary = event.summary;
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
      appendEvent({
        type: "failed",
        classification: "PROVIDER",
        error: { message: summary },
      });
      appendEvent({ type: "session_finished", outcome: "FAILED" });
    }
    return { failed, summary: summary || lastMessageText, nextSequence: sequence + 1 };
  }

  listSessionEvents(sessionIdInput: unknown): AgentEventEnvelope[] {
    if (typeof sessionIdInput !== "string" || sessionIdInput.trim().length === 0 || sessionIdInput.length > 128) {
      throw new InputValidationError("Session ID is invalid.");
    }
    return this.journal.listEventsForSession(sessionIdInput.trim());
  }

  listTasks(projectIdInput: unknown): TaskSummary[] {
    const projectId = parseProjectId(projectIdInput);
    const tasks = this.journal.listTasksForProject(projectId);
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
    return this.journal.listTasksForProject(projectId).map((task) => ({
      ...task,
      pendingQuestions: this.pendingQuestions(task.id),
    }));
  }

  async answerQuestion(inputValue: unknown): Promise<BrainstormResult> {
    const input = parseQuestionAnswer(inputValue);
    const question = this.pendingQuestions(input.taskId).find((candidate) => candidate.id === input.questionId);
    if (!question) throw new InputValidationError("Question is not waiting for an answer.");
    const latestSession = this.journal.getLatestSessionForTask(input.taskId, "BRAINSTORM");
    if (!latestSession) throw new InputValidationError("Task has no brainstorm session to answer.");
    this.journal.appendEvent({
      eventId: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      projectId: this.journal.getTask(input.taskId).projectId,
      taskId: input.taskId,
      sessionId: latestSession.id,
      sequence: this.nextEventSequence(input.taskId),
      persistence: "DURABLE",
      payload: { type: "question_answered", questionId: input.questionId },
    });
    return this.revise({
      taskId: input.taskId,
      feedback: `Answer to "${question.prompt}": ${input.answer}`,
    });
  }

  getLatestSpec(taskIdInput: unknown): TaskSpec | null {
    if (typeof taskIdInput !== "string" || taskIdInput.trim().length === 0 || taskIdInput.length > 128) {
      throw new InputValidationError("Task ID is invalid.");
    }
    return this.journal.getLatestSpec(taskIdInput.trim());
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
    const pending = this.pendingQuestions(task.id);
    if (pending.length > 0) return pending;
    if (task.status !== "DESIGN_REVIEW" && task.status !== "DRAFT" && task.status !== "WAITING_USER") return [];

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
