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
import type { NotificationSink } from "./desktop-notification-service";

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
    private readonly notifications?: NotificationSink,
  ) {}

  async start(taskIdInput: unknown): Promise<ExecutionResult> {
    const taskId = parseTaskId(taskIdInput);
    let task = this.journal.getTask(taskId);
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

    const lockOwnerId = randomUUID();
    const now = new Date().toISOString();
    const locked = this.journal.tryAcquireProjectExecutionLock({
      projectId: project.id,
      taskId: task.id,
      ownerId: lockOwnerId,
      acquiredAt: now,
    });
    if (!locked) {
      throw new InputValidationError("This project is already running another task.");
    }

    let attempt: ExecutionAttempt | undefined;
    let session: AgentSession | undefined;
    let started: Awaited<ReturnType<AgentProvider["startSession"]>> | undefined;
    let taskClaimed = false;
    try {
      task = this.journal.beginQueuedTaskExecution(task.id, now);
      taskClaimed = true;
      attempt = this.journal.createExecutionAttempt({
        id: randomUUID(),
        taskId: task.id,
        attemptNumber: this.journal.nextExecutionAttemptNumber(task.id),
        status: "EXECUTING",
        startedAt: now,
      });
      started = await provider.startSession({
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

      const result = await this.captureExecutionEvents({ provider, projectId: project.id, task, attempt, session });
      const finalStatus = result.failed ? "FAILED" : "DONE";
      this.journal.updateSessionStatus(session.id, "ENDED");
      this.journal.updateExecutionAttemptStatus(attempt.id, finalStatus, new Date().toISOString(), result.summary);
      this.journal.completeTaskExecution(task.id, finalStatus);
      if (finalStatus === "DONE") {
        this.notifications?.executionCompleted(project.name, task, result.summary);
      } else {
        this.notifications?.executionFailed(project.name, task, result.summary);
      }

      return {
        taskId: task.id,
        attemptId: attempt.id,
        sessionId: session.id,
        providerSessionId: started.session.providerSessionId,
        eventCount: this.journal.countEventsForSession(session.id),
        summary: result.summary,
      };
    } catch (error) {
      const summary = providerErrorMessage(error);
      if (started) {
        try {
          await provider.cancel(started.session, "Execution failed before Anubis could finish the session.");
        } catch (cancelError) {
          console.error("Failed to cancel provider session after execution error", cancelError);
        }
      }
      if (session) this.journal.updateSessionStatus(session.id, "ENDED");
      if (attempt) this.journal.updateExecutionAttemptStatus(attempt.id, "FAILED", new Date().toISOString(), summary);
      if (taskClaimed) {
        this.journal.completeTaskExecution(task.id, "FAILED");
        this.notifications?.executionFailed(project.name, task, summary);
      }
      throw error;
    } finally {
      this.journal.releaseProjectExecutionLock(project.id, lockOwnerId);
    }
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
