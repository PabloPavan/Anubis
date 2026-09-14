import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutionService } from "../../src/main/application/execution-service";
import type { NotificationSink } from "../../src/main/application/desktop-notification-service";
import { ProjectService } from "../../src/main/application/project-service";
import { openDatabase } from "../../src/main/database/database";
import type { AgentProvider, ProviderSessionRef, ResumeSessionInput, StartSessionInput } from "../../src/main/providers/agent-provider";
import { ProviderRegistry } from "../../src/main/providers/provider-registry";
import { AgentJournalRepository } from "../../src/main/repositories/agent-journal-repository";
import { ProjectRepository } from "../../src/main/repositories/project-repository";
import type { AgentEvent } from "../../src/shared/agent-events";
import type { AgentCapabilities } from "../../src/shared/app";
import { InputValidationError } from "../../src/shared/projects";

class FakeExecutionProvider implements AgentProvider {
  readonly id = "claude";
  readonly displayName = "Claude Test";
  lastStartInput: StartSessionInput | null = null;
  lastResumeInput: ResumeSessionInput | null = null;
  eventsToYield: AgentEvent[] = [
    { type: "session_started" },
    { type: "tool_started", callId: "edit-1", tool: "Edit", detail: "src/example.ts" },
    { type: "tool_finished", callId: "edit-1", tool: "Edit", detail: "src/example.ts" },
    { type: "completed", summary: "Implemented approved spec." },
    { type: "session_finished", outcome: "COMPLETED" },
  ];

  async startSession(input: StartSessionInput): Promise<{ session: ProviderSessionRef }> {
    this.lastStartInput = input;
    return { session: { provider: "claude", providerSessionId: "execution-session-1" } };
  }

  async resumeSession(input: ResumeSessionInput): Promise<{ session: ProviderSessionRef }> {
    this.lastResumeInput = input;
    return { session: { provider: "claude", providerSessionId: "execution-session-resumed" } };
  }

  async sendMessage(_session: ProviderSessionRef, _message: string): Promise<void> {}

  async *events(_session: ProviderSessionRef, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    for (const event of this.eventsToYield) yield event;
  }

  async cancel(_session: ProviderSessionRef, _reason: string): Promise<void> {}

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      cancellation: true,
      resume: true,
      structuredQuestions: false,
      subagentEvents: true,
    };
  }

  async health(): Promise<{ available: boolean }> {
    return { available: true };
  }
}

class FakeNotifications implements NotificationSink {
  calls: string[] = [];

  brainstormNeedsAnswer(): void {
    this.calls.push("brainstormNeedsAnswer");
  }

  brainstormReadyForReview(): void {
    this.calls.push("brainstormReadyForReview");
  }

  brainstormFailed(): void {
    this.calls.push("brainstormFailed");
  }

  executionCompleted(): void {
    this.calls.push("executionCompleted");
  }

  executionFailed(): void {
    this.calls.push("executionFailed");
  }
}

class FakeTurnBudgetSettings {
  controlledMaxTurns = true;

  get(): { controlledMaxTurns: boolean } {
    return { controlledMaxTurns: this.controlledMaxTurns };
  }
}

describe("execution service", () => {
  let directory: string;
  let database: DatabaseSync;
  let projects: ProjectService;
  let projectRepository: ProjectRepository;
  let journal: AgentJournalRepository;
  let provider: FakeExecutionProvider;
  let notifications: FakeNotifications;
  let service: ExecutionService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "anubis-execution-"));
    database = openDatabase(":memory:");
    projectRepository = new ProjectRepository(database);
    journal = new AgentJournalRepository(database);
    projects = new ProjectService(projectRepository);
    provider = new FakeExecutionProvider();
    notifications = new FakeNotifications();
    const providers = new ProviderRegistry();
    providers.register(provider);
    service = new ExecutionService(projectRepository, journal, providers, notifications);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("executes a queued task with an approved spec", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = "2026-09-04T12:00:00.000Z";
    const task = journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: journal.nextTaskNumber(project.id),
      title: "Implement approved work",
      description: "Use the stored spec.",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 0,
      now,
    });
    const spec = journal.createTaskSpec({
      id: randomUUID(),
      taskId: task.id,
      contentMarkdown: "## Spec\nChange one focused behavior.",
      sha256: createHash("sha256").update("## Spec\nChange one focused behavior.").digest("hex"),
      createdAt: now,
    });
    journal.approveLatestSpec(task.id, now);

    const result = await service.start(task.id);

    expect(provider.lastStartInput).toMatchObject({
      maxTurns: 60,
      metadata: { purpose: "execution", projectId: project.id, taskId: task.id },
      permissionMode: "bypassPermissions",
      toolMode: "edit",
      prompt: expect.stringContaining(spec.contentMarkdown),
    });
    expect(provider.lastStartInput?.cwd).toBeTruthy();
    expect(result).toMatchObject({
      taskId: task.id,
      providerSessionId: "execution-session-1",
      eventCount: 5,
      summary: "Implemented approved spec.",
    });
    expect(journal.getTask(task.id)).toMatchObject({ status: "EXECUTION_REVIEW" });
    expect(journal.listEventsForSession(result.sessionId).map((event) => event.payload.type)).toEqual([
      "session_started",
      "tool_started",
      "tool_finished",
      "completed",
      "session_finished",
    ]);
    expect(notifications.calls).toEqual([]);

    const reviewed = service.reviewExecution({
      taskId: task.id,
      decision: "complete",
      memoryUpdate: "Future executions should preserve the approved spec boundaries.",
    });

    expect(reviewed).toMatchObject({ id: task.id, status: "DONE" });
    expect(journal.getProjectMemory(project.id).contentMarkdown).toContain("Task #1: Implement approved work");
    expect(journal.getProjectMemory(project.id).contentMarkdown).toContain("Outcome: Accepted as complete.");
    expect(journal.getProjectMemory(project.id).contentMarkdown).toContain("Future executions should preserve the approved spec boundaries.");
    expect(notifications.calls).toEqual(["executionCompleted"]);
  });

  it("omits execution max turns when controlled turns are disabled", async () => {
    const settings = new FakeTurnBudgetSettings();
    settings.controlledMaxTurns = false;
    const providers = new ProviderRegistry();
    providers.register(provider);
    service = new ExecutionService(projectRepository, journal, providers, notifications, settings);
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = "2026-09-04T12:00:00.000Z";
    const task = journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: journal.nextTaskNumber(project.id),
      title: "Use provider turns",
      description: "Let Claude decide the turn budget.",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 0,
      now,
    });
    const content = "## Spec\nChange one focused behavior.";
    journal.createTaskSpec({
      id: randomUUID(),
      taskId: task.id,
      contentMarkdown: content,
      sha256: createHash("sha256").update(content).digest("hex"),
      createdAt: now,
    });
    journal.approveLatestSpec(task.id, now);

    await service.start(task.id);

    expect(provider.lastStartInput?.maxTurns).toBeUndefined();
  });

  it("persists long execution completion summaries without marking the task as failed", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = "2026-09-04T12:00:00.000Z";
    const task = journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: journal.nextTaskNumber(project.id),
      title: "Long completion report",
      description: "Use the stored spec.",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 0,
      now,
    });
    journal.createTaskSpec({
      id: randomUUID(),
      taskId: task.id,
      contentMarkdown: "## Spec\nChange one focused behavior.",
      sha256: createHash("sha256").update("## Spec\nChange one focused behavior.").digest("hex"),
      createdAt: now,
    });
    journal.approveLatestSpec(task.id, now);
    const summary = `# Execution summary\n\n${"Implemented and verified one behavior.\n".repeat(160)}`;
    provider.eventsToYield = [
      { type: "session_started" },
      { type: "completed", summary },
      { type: "session_finished", outcome: "COMPLETED" },
    ];

    const result = await service.start(task.id);

    expect(result).toMatchObject({
      taskId: task.id,
      eventCount: 3,
      summary,
    });
    expect(journal.getTask(task.id)).toMatchObject({ status: "EXECUTION_REVIEW" });
    expect(journal.listEventsForTask(task.id).map((event) => event.payload.type)).toEqual([
      "session_started",
      "completed",
      "session_finished",
    ]);
    expect(notifications.calls).toEqual([]);
  });

  it("keeps execution review open for more instructions", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = "2026-09-04T12:00:00.000Z";
    const task = journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: journal.nextTaskNumber(project.id),
      title: "Needs review",
      description: "Use the stored spec.",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 0,
      now,
    });
    journal.createTaskSpec({
      id: randomUUID(),
      taskId: task.id,
      contentMarkdown: "## Spec\nChange one focused behavior.",
      sha256: createHash("sha256").update("## Spec\nChange one focused behavior.").digest("hex"),
      createdAt: now,
    });
    journal.approveLatestSpec(task.id, now);

    await service.start(task.id);
    const reviewed = service.reviewExecution({
      taskId: task.id,
      decision: "changes",
      feedback: "Finish the implementation and rerun the build.",
    });

    expect(reviewed).toMatchObject({ id: task.id, status: "READY_TO_RESUME" });
    expect(journal.listEventsForTask(task.id).at(-1)?.payload).toMatchObject({
      type: "execution_reviewed",
      decision: "changes",
      feedback: "Finish the implementation and rerun the build.",
    });
    expect(notifications.calls).toEqual([]);

    await service.start(task.id);

    expect(provider.lastResumeInput?.prompt).toContain(
      "user_execution_review: changes - Finish the implementation and rerun the build.",
    );
    expect(journal.getTask(task.id)).toMatchObject({ status: "EXECUTION_REVIEW" });
  });

  it("rejects execution without an approved queued spec", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const task = journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: journal.nextTaskNumber(project.id),
      title: "Not approved",
      description: "Missing approved spec.",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 0,
      now: "2026-09-04T12:00:00.000Z",
    });

    await expect(service.start(task.id)).rejects.toBeInstanceOf(InputValidationError);
  });

  it("marks recoverable execution failures as ready to resume", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = "2026-09-04T12:00:00.000Z";
    const task = journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: journal.nextTaskNumber(project.id),
      title: "Long execution",
      description: "Can hit limits.",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 0,
      now,
    });
    journal.createTaskSpec({
      id: randomUUID(),
      taskId: task.id,
      contentMarkdown: "## Spec\nChange one focused behavior.",
      sha256: createHash("sha256").update("## Spec\nChange one focused behavior.").digest("hex"),
      createdAt: now,
    });
    journal.approveLatestSpec(task.id, now);
    provider.eventsToYield = [
      { type: "session_started" },
      {
        type: "failed",
        classification: "PROVIDER",
        error: {
          message: "Claude Code returned an error result: Reached maximum number of turns (20)",
          code: "max_turns",
        },
      },
      { type: "session_finished", outcome: "FAILED" },
    ];

    const result = await service.start(task.id);

    expect(result).toMatchObject({ taskId: task.id, eventCount: 3 });
    expect(journal.getTask(task.id)).toMatchObject({ status: "READY_TO_RESUME", lastFailureCode: "max_turns" });
    expect(journal.getTask(task.id).autoResumeAt).toBeUndefined();
    expect(notifications.calls).toEqual(["executionFailed"]);
  });

  it("schedules auto-resume when Claude reports a five-hour rate limit reset", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = "2026-09-04T12:00:00.000Z";
    const task = journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: journal.nextTaskNumber(project.id),
      title: "Wait for reset",
      description: "Can continue later.",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 0,
      now,
    });
    journal.createTaskSpec({
      id: randomUUID(),
      taskId: task.id,
      contentMarkdown: "## Spec\nChange one focused behavior.",
      sha256: createHash("sha256").update("## Spec\nChange one focused behavior.").digest("hex"),
      createdAt: now,
    });
    journal.approveLatestSpec(task.id, now);
    provider.eventsToYield = [
      { type: "session_started" },
      {
        type: "rate_limit_updated",
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: "2026-09-04T17:00:00.000Z",
      },
      {
        type: "failed",
        classification: "RATE_LIMIT",
        error: { message: "Claude rate limit reached.", code: "five_hour" },
      },
      { type: "session_finished", outcome: "FAILED" },
    ];

    await service.start(task.id);

    expect(journal.getTask(task.id)).toMatchObject({
      status: "READY_TO_RESUME",
      autoResumeAt: "2026-09-04T17:00:30.000Z",
      lastFailureCode: "five_hour",
    });
    expect(journal.listRunnableQueuedTasks(10, true, "2026-09-04T17:00:29.000Z")).toEqual([]);
    expect(journal.listRunnableQueuedTasks(10, false, "2026-09-04T17:00:31.000Z")).toEqual([]);
    expect(journal.listRunnableQueuedTasks(10, true, "2026-09-04T17:00:31.000Z")).toMatchObject([
      { id: task.id, status: "READY_TO_RESUME" },
    ]);
  });

  it("resumes a task from the previous execution session", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = "2026-09-04T12:00:00.000Z";
    const task = journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: journal.nextTaskNumber(project.id),
      title: "Resume work",
      description: "Use previous session.",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 0,
      now,
    });
    journal.createTaskSpec({
      id: randomUUID(),
      taskId: task.id,
      contentMarkdown: "## Spec\nChange one focused behavior.",
      sha256: createHash("sha256").update("## Spec\nChange one focused behavior.").digest("hex"),
      createdAt: now,
    });
    journal.approveLatestSpec(task.id, now);
    const attempt = journal.createExecutionAttempt({
      id: randomUUID(),
      taskId: task.id,
      attemptNumber: 1,
      status: "INTERRUPTED",
      startedAt: now,
    });
    journal.createSession({
      id: randomUUID(),
      taskId: task.id,
      attemptId: attempt.id,
      provider: "claude",
      providerSessionId: "execution-session-original",
      type: "EXECUTION",
      status: "ENDED",
      createdAt: now,
    });
    journal.updateTaskStatus(task.id, "READY_TO_RESUME", now);

    const result = await service.start(task.id);

    expect(provider.lastResumeInput).toMatchObject({
      maxTurns: 240,
      session: { provider: "claude", providerSessionId: "execution-session-original" },
      permissionMode: "bypassPermissions",
      toolMode: "edit",
      prompt: expect.stringContaining("Resume an interrupted Anubis implementation task"),
    });
    expect(provider.lastResumeInput?.cwd).toBeTruthy();
    expect(result).toMatchObject({
      taskId: task.id,
      providerSessionId: "execution-session-resumed",
      eventCount: 5,
    });
    expect(journal.getTask(task.id)).toMatchObject({ status: "EXECUTION_REVIEW" });
    expect(notifications.calls).toEqual([]);
  });

  it("resumes with a larger turn budget after max turns were reached", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = "2026-09-04T12:00:00.000Z";
    const task = journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: journal.nextTaskNumber(project.id),
      title: "Resume long work",
      description: "Use previous session.",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 0,
      now,
    });
    journal.createTaskSpec({
      id: randomUUID(),
      taskId: task.id,
      contentMarkdown: "## Spec\nChange several focused behaviors.",
      sha256: createHash("sha256").update("## Spec\nChange several focused behaviors.").digest("hex"),
      createdAt: now,
    });
    journal.approveLatestSpec(task.id, now);
    const attempt = journal.createExecutionAttempt({
      id: randomUUID(),
      taskId: task.id,
      attemptNumber: 1,
      status: "INTERRUPTED",
      startedAt: now,
    });
    journal.createSession({
      id: randomUUID(),
      taskId: task.id,
      attemptId: attempt.id,
      provider: "claude",
      providerSessionId: "execution-session-original",
      type: "EXECUTION",
      status: "ENDED",
      createdAt: now,
    });
    journal.completeTaskExecution(task.id, "READY_TO_RESUME", now, { failureCode: "max_turns" });

    await service.start(task.id);

    expect(provider.lastResumeInput).toMatchObject({
      maxTurns: 240,
      permissionMode: "bypassPermissions",
      toolMode: "edit",
    });
  });
});
