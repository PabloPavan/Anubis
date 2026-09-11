import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventEnvelope, FailureClass } from "../../shared/agent-events";
import type { ExecutionResult, ExecutionReviewDecisionInput, TaskSummary } from "../../shared/app";
import { InputValidationError } from "../../shared/projects";
import type { AgentSession, ExecutionAttempt, Task } from "../../shared/tasks";
import type { AgentProvider } from "../providers/agent-provider";
import { ProviderUnavailableError } from "../providers/agent-provider";
import { ProviderRegistry } from "../providers/provider-registry";
import { AgentJournalRepository } from "../repositories/agent-journal-repository";
import { ProjectRepository } from "../repositories/project-repository";
import { implementationPrompt, resumeImplementationPrompt } from "../workflows/execution-workflow";
import type { NotificationSink } from "./desktop-notification-service";

const executionMaxTurns = 60;
const maxTurnsRecoveryResume = 200;

function parseTaskId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new InputValidationError("Task ID is invalid.");
  }
  return value.trim();
}

function parseExecutionReviewDecision(value: unknown): ExecutionReviewDecisionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("Execution review input is invalid.");
  }
  const input = value as Record<string, unknown>;
  const taskId = parseTaskId(input.taskId);
  if (input.decision !== "complete" && input.decision !== "changes") {
    throw new InputValidationError("Execution review decision is invalid.");
  }
  const feedback = typeof input.feedback === "string" ? input.feedback.trim() : "";
  if (input.decision === "changes" && feedback.length === 0) {
    throw new InputValidationError("Describe what still needs to change.");
  }
  if (feedback.length > 20_000) {
    throw new InputValidationError("Execution review feedback is too long.");
  }
  const memoryUpdate = typeof input.memoryUpdate === "string" ? input.memoryUpdate.trim() : "";
  if (memoryUpdate.length > 4_000) {
    throw new InputValidationError("Project memory update is too long.");
  }
  return {
    taskId,
    decision: input.decision,
    ...(feedback ? { feedback } : {}),
    ...(memoryUpdate ? { memoryUpdate } : {}),
  };
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Agent execution failed.";
}

function isRecoverableFailure(input: { classification?: FailureClass; code?: string; summary: string }): boolean {
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

function memoryEntry(task: Task, memoryUpdate: string, createdAt: string): string {
  return [
    `## Task #${task.taskNumber}: ${task.title}`,
    `Updated: ${createdAt}`,
    "",
    "Outcome: Accepted as complete.",
    "",
    "Memory update:",
    memoryUpdate.trim().slice(0, 4_000),
  ].filter(Boolean).join("\n");
}

function latestCompletionSummary(events: AgentEventEnvelope[]): string {
  const completed = [...events].reverse().find((event) => event.payload.type === "completed" && event.payload.summary?.trim());
  if (completed?.payload.type === "completed" && completed.payload.summary?.trim()) {
    return completed.payload.summary.trim();
  }
  const message = [...events].reverse().find((event) => event.payload.type === "message_completed" && event.payload.text?.trim());
  if (message?.payload.type === "message_completed" && message.payload.text?.trim()) {
    return message.payload.text.trim();
  }
  return "Execution was accepted as complete, but the agent did not provide a final summary.";
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
    const resume = task.status === "READY_TO_RESUME";
    if (task.status !== "QUEUED" && !resume) {
      throw new InputValidationError("Only queued or resumable tasks can be executed.");
    }

    const project = this.projects.get(task.projectId);
    const spec = this.journal.getLatestSpec(task.id);
    if (!spec?.approvedAt) {
      throw new InputValidationError("Task needs an approved spec before execution.");
    }
    const provider = this.providers.get(task.provider);
    if (!provider) throw new ProviderUnavailableError("Task provider is not registered.");
    if (resume && !provider.capabilities().resume) {
      throw new ProviderUnavailableError("Task provider does not support session resume.");
    }
    const previousSession = resume ? this.journal.getLatestSessionForTask(task.id, "EXECUTION") : null;
    if (resume && !previousSession?.providerSessionId) {
      throw new InputValidationError("Task does not have a previous execution session to resume.");
    }

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
      if (resume) {
        task = this.journal.beginResumedTaskExecution(task.id, now);
      } else {
        task = this.journal.beginQueuedTaskExecution(task.id, now);
      }
      taskClaimed = true;
      attempt = this.journal.createExecutionAttempt({
        id: randomUUID(),
        taskId: task.id,
        attemptNumber: this.journal.nextExecutionAttemptNumber(task.id),
        status: "EXECUTING",
        startedAt: now,
      });
      const taskSummary = {
        id: task.id,
        projectId: task.projectId,
        taskNumber: task.taskNumber,
        title: task.title,
        description: task.description,
        status: task.status,
        model: task.model,
        effort: task.effort,
        updatedAt: task.updatedAt,
        latestActivityAt: task.updatedAt,
        pendingQuestions: [],
        contextTaskIds: [],
        eventCount: 0,
      };
      started = resume
        ? await provider.resumeSession({
            session: {
              provider: task.provider,
              providerSessionId: previousSession?.providerSessionId ?? "",
            },
            cwd: project.path,
            prompt: resumeImplementationPrompt(taskSummary, spec, this.journal.listEventsForTask(task.id)),
            maxTurns: task.lastFailureCode === "max_turns" ? maxTurnsRecoveryResume : executionMaxTurns,
            model: task.model,
            effort: task.effort,
            toolMode: "edit",
            permissionMode: "bypassPermissions",
          })
        : await provider.startSession({
            cwd: project.path,
            prompt: implementationPrompt(taskSummary, spec),
            metadata: { purpose: "execution", projectId: project.id, taskId: task.id },
            maxTurns: executionMaxTurns,
            model: task.model,
            effort: task.effort,
            toolMode: "edit",
            permissionMode: "bypassPermissions",
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
      const finalStatus = result.failed
        ? isRecoverableFailure(result)
          ? "READY_TO_RESUME"
          : "FAILED"
        : "EXECUTION_REVIEW";
      const attemptStatus = finalStatus === "READY_TO_RESUME" ? "INTERRUPTED" : result.failed ? "FAILED" : "DONE";
      this.journal.updateSessionStatus(session.id, "ENDED");
      this.journal.updateExecutionAttemptStatus(
        attempt.id,
        attemptStatus,
        new Date().toISOString(),
        result.summary,
      );
      const scheduledAutoResumeAt = finalStatus === "READY_TO_RESUME" ? autoResumeAt(result) : undefined;
      this.journal.completeTaskExecution(task.id, finalStatus, new Date().toISOString(), {
        ...(scheduledAutoResumeAt ? { autoResumeAt: scheduledAutoResumeAt } : {}),
        ...(result.code ? { failureCode: result.code } : {}),
      });
      if (result.failed) {
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
      const recoverable = started
        ? isRecoverableFailure({ summary, classification: "PROVIDER" })
        : false;
      if (attempt) {
        this.journal.updateExecutionAttemptStatus(
          attempt.id,
          recoverable ? "INTERRUPTED" : "FAILED",
          new Date().toISOString(),
          summary,
        );
      }
      if (taskClaimed) {
        this.journal.completeTaskExecution(task.id, recoverable ? "READY_TO_RESUME" : "FAILED");
        this.notifications?.executionFailed(project.name, task, summary);
      }
      throw error;
    } finally {
      this.journal.releaseProjectExecutionLock(project.id, lockOwnerId);
    }
  }

  reviewExecution(inputValue: unknown): TaskSummary {
    const input = parseExecutionReviewDecision(inputValue);
    const task = this.journal.getTask(input.taskId);
    if (task.status !== "EXECUTION_REVIEW") {
      throw new InputValidationError("Only tasks waiting for execution review can be reviewed.");
    }
    const project = this.projects.get(task.projectId);
    const session = this.journal.getLatestSessionForTask(task.id, "EXECUTION");
    if (!session) {
      throw new InputValidationError("Task has no execution session to review.");
    }
    const now = new Date().toISOString();
    this.journal.appendEvent({
      eventId: randomUUID(),
      schemaVersion: 1,
      occurredAt: now,
      projectId: task.projectId,
      taskId: task.id,
      sessionId: session.id,
      sequence: this.journal.countEventsForSession(session.id) + 1,
      persistence: "DURABLE",
      payload: {
        type: "execution_reviewed",
        decision: input.decision,
        ...(input.feedback ? { feedback: input.feedback } : {}),
      },
    });
    const updated = this.journal.completeTaskExecution(
      task.id,
      input.decision === "complete" ? "DONE" : "READY_TO_RESUME",
      now,
    );
    if (input.decision === "complete") {
      const finalSummary = latestCompletionSummary(this.journal.listEventsForTask(task.id));
      if (input.memoryUpdate) {
        this.journal.appendProjectMemoryEntry(task.projectId, memoryEntry(task, input.memoryUpdate, now), now);
      }
      this.notifications?.executionCompleted(project.name, task, finalSummary);
    }
    const summary = this.journal.listTasksForProject(updated.projectId, null).find((candidate) => candidate.id === updated.id);
    if (!summary) throw new InputValidationError("Reviewed task could not be loaded.");
    return summary;
  }

  private async captureExecutionEvents(input: {
    provider: AgentProvider;
    projectId: string;
    task: Task;
    attempt: ExecutionAttempt;
    session: AgentSession;
  }): Promise<{
    failed: boolean;
    summary: string;
    classification?: FailureClass;
    code?: string;
    rateLimitType?: string;
    rateLimitResetAt?: string;
  }> {
    let sequence = 0;
    let summary = "";
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

    return {
      failed,
      summary,
      ...(classification ? { classification } : {}),
      ...(code ? { code } : {}),
      ...(rateLimitType ? { rateLimitType } : {}),
      ...(rateLimitResetAt ? { rateLimitResetAt } : {}),
    };
  }
}
