import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventEnvelope } from "../../shared/agent-events";
import type { BrainstormDraft, BrainstormResult, TaskSummary } from "../../shared/app";
import { InputValidationError, parseProjectId } from "../../shared/projects";
import type { AgentSession, Task } from "../../shared/tasks";
import { AgentJournalRepository } from "../repositories/agent-journal-repository";
import { ProjectRepository } from "../repositories/project-repository";
import { ProviderRegistry } from "../providers/provider-registry";
import { ProviderUnavailableError } from "../providers/agent-provider";

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

function brainstormPrompt(input: BrainstormDraft): string {
  return [
    "You are helping with an Anubis brainstorm session for a local software project.",
    "This is design-only. Do not modify files. Do not run write commands. Inspect only if useful.",
    "Use the repository context to clarify the requested work and propose a concise implementation direction.",
    "",
    `Task title: ${input.title}`,
    "",
    "Task description:",
    input.description,
    "",
    "Respond with: goals, relevant files or areas to inspect later, key questions/risks, and a recommended next step.",
  ].join("\n");
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Claude brainstorm failed.";
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
      prompt: brainstormPrompt(input),
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

    const appendEvent = (event: AgentEvent): void => {
      sequence += 1;
      if (event.type === "completed" && event.summary) summary = event.summary;
      this.journal.appendEvent({
        eventId: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        projectId: project.id,
        taskId: task.id,
        sessionId: session.id,
        sequence,
        persistence: "DURABLE",
        payload: event,
      });
    };

    let sequence = 0;
    let summary = "";
    let lastMessageText = "";
    let failed = false;
    try {
      for await (const event of provider.events(started.session, new AbortController().signal)) {
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
    this.journal.updateTaskStatus(task.id, failed ? "FAILED" : "DESIGN_REVIEW");

    return {
      taskId: task.id,
      sessionId: session.id,
      providerSessionId: started.session.providerSessionId,
      eventCount: this.journal.countEventsForSession(session.id),
      summary,
    };
  }

  listSessionEvents(sessionIdInput: unknown): AgentEventEnvelope[] {
    if (typeof sessionIdInput !== "string" || sessionIdInput.trim().length === 0 || sessionIdInput.length > 128) {
      throw new InputValidationError("Session ID is invalid.");
    }
    return this.journal.listEventsForSession(sessionIdInput.trim());
  }

  listTasks(projectIdInput: unknown): TaskSummary[] {
    return this.journal.listTasksForProject(parseProjectId(projectIdInput));
  }
}
