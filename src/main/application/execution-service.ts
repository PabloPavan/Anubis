import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventEnvelope } from "../../shared/agent-events";
import type { ExecutionResult } from "../../shared/app";
import { InputValidationError } from "../../shared/projects";
import type { AgentSession, ExecutionAttempt, Task } from "../../shared/tasks";
import type { AgentProvider } from "../providers/agent-provider";
import { ProviderUnavailableError } from "../providers/agent-provider";
import { ProviderRegistry } from "../providers/provider-registry";
import { AgentJournalRepository } from "../repositories/agent-journal-repository";
import { ProjectRepository } from "../repositories/project-repository";
import { implementationPrompt } from "../workflows/execution-workflow";

function parseTaskId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new InputValidationError("Task ID is invalid.");
  }
  return value.trim();
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Claude execution failed.";
}

export class ExecutionService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly journal: AgentJournalRepository,
    private readonly providers: ProviderRegistry,
  ) {}

  async start(taskIdInput: unknown): Promise<ExecutionResult> {
    const taskId = parseTaskId(taskIdInput);
    const task = this.journal.getTask(taskId);
    if (task.status !== "QUEUED") {
      throw new InputValidationError("Only queued tasks can be executed.");
    }

    const project = this.projects.get(task.projectId);
    const spec = this.journal.getLatestSpec(task.id);
    if (!spec?.approvedAt) {
      throw new InputValidationError("Task needs an approved spec before execution.");
    }
    const provider = this.providers.get(task.provider);
    if (!provider) throw new ProviderUnavailableError("Task provider is not registered.");

    const started = await provider.startSession({
      cwd: project.path,
      prompt: implementationPrompt(
        {
          id: task.id,
          projectId: task.projectId,
          taskNumber: task.taskNumber,
          title: task.title,
          status: task.status,
          updatedAt: task.updatedAt,
          latestActivityAt: task.updatedAt,
          pendingQuestions: [],
          eventCount: 0,
        },
        spec,
      ),
      metadata: { purpose: "execution", projectId: project.id, taskId: task.id },
      maxTurns: 20,
      toolMode: "edit",
      permissionMode: "acceptEdits",
    });

    const now = new Date().toISOString();
    let attempt: ExecutionAttempt;
    let session: AgentSession;
    try {
      this.journal.updateTaskStatus(task.id, "EXECUTING", now);
      attempt = this.journal.createExecutionAttempt({
        id: randomUUID(),
        taskId: task.id,
        attemptNumber: this.journal.nextExecutionAttemptNumber(task.id),
        status: "EXECUTING",
        startedAt: now,
      });
      session = this.journal.createSession({
        id: randomUUID(),
        taskId: task.id,
        attemptId: attempt.id,
        provider: task.provider,
        providerSessionId: started.session.providerSessionId,
        type: "EXECUTION",
        status: "ACTIVE",
        createdAt: now,
      });
    } catch (error) {
      await provider.cancel(started.session, "Failed to persist execution metadata.");
      throw error;
    }

    const result = await this.captureExecutionEvents({ provider, projectId: project.id, task, attempt, session });
    const finalStatus = result.failed ? "FAILED" : "DONE";
    this.journal.updateSessionStatus(session.id, "ENDED");
    this.journal.updateExecutionAttemptStatus(attempt.id, finalStatus, new Date().toISOString(), result.summary);
    this.journal.updateTaskStatus(task.id, finalStatus);

    return {
      taskId: task.id,
      attemptId: attempt.id,
      sessionId: session.id,
      providerSessionId: started.session.providerSessionId,
      eventCount: this.journal.countEventsForSession(session.id),
      summary: result.summary,
    };
  }

  private async captureExecutionEvents(input: {
    provider: AgentProvider;
    projectId: string;
    task: Task;
    attempt: ExecutionAttempt;
    session: AgentSession;
  }): Promise<{ failed: boolean; summary: string }> {
    let sequence = 0;
    let summary = "";
    let failed = false;

    const appendEvent = (event: AgentEvent): void => {
      sequence += 1;
      if (event.type === "completed" && event.summary) summary = event.summary;
      if (event.type === "failed") failed = true;
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
      for await (const event of input.provider.events(
        { provider: input.task.provider, providerSessionId: input.session.providerSessionId ?? "" },
        new AbortController().signal,
      )) {
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

    return { failed, summary };
  }
}
