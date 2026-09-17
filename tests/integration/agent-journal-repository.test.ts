import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectService } from "../../src/main/application/project-service";
import { openDatabase } from "../../src/main/database/database";
import {
  AgentJournalConflictError,
  AgentJournalRepository,
} from "../../src/main/repositories/agent-journal-repository";
import { ProjectRepository } from "../../src/main/repositories/project-repository";
import { TaskValidationError } from "../../src/shared/tasks";

describe("agent journal persistence", () => {
  let directory: string;
  let database: DatabaseSync;
  let projects: ProjectService;
  let journal: AgentJournalRepository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "anubis-journal-"));
    database = openDatabase(":memory:");
    projects = new ProjectService(new ProjectRepository(database));
    journal = new AgentJournalRepository(database);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("persists tasks, attempts, sessions, and ordered events", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = "2026-09-03T14:00:00.000Z";

    const task = journal.createTask({
      id: "task-1",
      projectId: project.id,
      taskNumber: 1,
      title: "Add journal",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 1,
      now,
    });
    expect(task).toMatchObject({
      id: "task-1",
      projectId: project.id,
      taskNumber: 1,
      status: "QUEUED",
    });

    const attempt = journal.createExecutionAttempt({
      id: "attempt-1",
      taskId: task.id,
      attemptNumber: 1,
      status: "PLANNING",
      startedAt: now,
    });
    expect(attempt).toMatchObject({ id: "attempt-1", taskId: task.id });

    const session = journal.createSession({
      id: "session-1",
      taskId: task.id,
      attemptId: attempt.id,
      provider: "claude",
      providerSessionId: "provider-session-1",
      type: "EXECUTION",
      status: "ACTIVE",
      createdAt: now,
    });
    expect(session).toMatchObject({
      id: "session-1",
      taskId: task.id,
      attemptId: attempt.id,
      providerSessionId: "provider-session-1",
    });

    journal.appendEvent({
      eventId: "event-2",
      schemaVersion: 1,
      occurredAt: "2026-09-03T14:00:02.000Z",
      projectId: project.id,
      taskId: task.id,
      sessionId: session.id,
      sequence: 2,
      persistence: "DURABLE",
      payload: { type: "stage_changed", stage: "PLANNING" },
    });
    journal.appendEvent({
      eventId: "event-1",
      schemaVersion: 1,
      occurredAt: "2026-09-03T14:00:01.000Z",
      projectId: project.id,
      taskId: task.id,
      sessionId: session.id,
      sequence: 1,
      persistence: "DURABLE",
      payload: { type: "session_started" },
    });

    expect(journal.listEventsForSession(session.id)).toEqual([
      {
        eventId: "event-1",
        schemaVersion: 1,
        occurredAt: "2026-09-03T14:00:01.000Z",
        projectId: project.id,
        taskId: task.id,
        sessionId: session.id,
        sequence: 1,
        persistence: "DURABLE",
        payload: { type: "session_started" },
      },
      {
        eventId: "event-2",
        schemaVersion: 1,
        occurredAt: "2026-09-03T14:00:02.000Z",
        projectId: project.id,
        taskId: task.id,
        sessionId: session.id,
        sequence: 2,
        persistence: "DURABLE",
        payload: { type: "stage_changed", stage: "PLANNING" },
      },
    ]);
  });

  it("orders task summaries by latest task activity and exposes the latest event", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const olderTask = journal.createTask({
      id: "task-older-update",
      projectId: project.id,
      taskNumber: 1,
      title: "Has newest event",
      status: "DESIGN_REVIEW",
      provider: "claude",
      workflow: "superpowers",
      position: 1,
      now: "2026-09-03T14:00:00.000Z",
    });
    const newerTask = journal.createTask({
      id: "task-newer-update",
      projectId: project.id,
      taskNumber: 2,
      title: "Has only task update",
      status: "DESIGN_REVIEW",
      provider: "claude",
      workflow: "superpowers",
      position: 2,
      now: "2026-09-03T14:01:00.000Z",
    });
    const session = journal.createSession({
      id: "session-newest-event",
      taskId: olderTask.id,
      provider: "claude",
      providerSessionId: "provider-session-activity",
      type: "BRAINSTORM",
      status: "ENDED",
      createdAt: "2026-09-03T14:00:00.000Z",
    });
    journal.createSession({
      id: "session-no-events",
      taskId: newerTask.id,
      provider: "claude",
      providerSessionId: "provider-session-no-events",
      type: "BRAINSTORM",
      status: "ENDED",
      createdAt: "2026-09-03T14:01:00.000Z",
    });
    journal.appendEvent({
      eventId: "event-newest",
      schemaVersion: 1,
      occurredAt: "2026-09-03T14:02:00.000Z",
      projectId: project.id,
      taskId: olderTask.id,
      sessionId: session.id,
      sequence: 1,
      persistence: "DURABLE",
      payload: {
        type: "question_asked",
        question: { id: "question-1", prompt: "Which path should be used?", options: ["A", "B"] },
      },
    });

    const summaries = journal.listTasksForProject(project.id);

    expect(summaries[0]).toMatchObject({
      id: olderTask.id,
      latestActivityAt: "2026-09-03T14:02:00.000Z",
      latestEventType: "question_asked",
      latestEventText: "Which path should be used?",
    });
    expect(summaries[1]).toMatchObject({
      id: newerTask.id,
      latestActivityAt: "2026-09-03T14:01:00.000Z",
    });
  });

  it("can list all project tasks when the limit is disabled", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });

    for (let index = 1; index <= 22; index += 1) {
      journal.createTask({
        id: `task-${index}`,
        projectId: project.id,
        taskNumber: index,
        title: `Task ${index}`,
        status: "DRAFT",
        provider: "claude",
        workflow: "superpowers",
        position: index,
        now: `2026-09-03T14:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }

    expect(journal.listTasksForProject(project.id)).toHaveLength(20);
    expect(journal.listTasksForProject(project.id, null)).toHaveLength(22);
  });

  it("claims one runnable queued task per unlocked project", async () => {
    const secondDirectory = join(directory, "tools");
    await mkdir(secondDirectory);
    const firstProject = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const secondProject = await projects.create({
      name: "Tools",
      path: secondDirectory,
      provider: "claude",
      workflow: "superpowers",
    });
    const firstTask = journal.createTask({
      id: "first-task",
      projectId: firstProject.id,
      taskNumber: 1,
      title: "First",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 1,
      now: "2026-09-03T14:00:00.000Z",
    });
    journal.createTask({
      id: "second-task-same-project",
      projectId: firstProject.id,
      taskNumber: 2,
      title: "Second same project",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 2,
      now: "2026-09-03T14:01:00.000Z",
    });
    const otherProjectTask = journal.createTask({
      id: "other-project-task",
      projectId: secondProject.id,
      taskNumber: 1,
      title: "Other project",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 1,
      now: "2026-09-03T14:02:00.000Z",
    });

    expect(
      journal.tryAcquireProjectExecutionLock({
        projectId: firstProject.id,
        taskId: firstTask.id,
        ownerId: "owner-1",
        acquiredAt: "2026-09-03T14:03:00.000Z",
      }),
    ).toBe(true);
    expect(
      journal.tryAcquireProjectExecutionLock({
        projectId: firstProject.id,
        taskId: firstTask.id,
        ownerId: "owner-2",
        acquiredAt: "2026-09-03T14:03:01.000Z",
      }),
    ).toBe(false);

    expect(journal.listRunnableQueuedTasks().map((task) => task.id)).toEqual([otherProjectTask.id]);
    journal.releaseProjectExecutionLock(firstProject.id, "owner-1");
    expect(journal.listRunnableQueuedTasks().map((task) => task.id)).toEqual([
      firstTask.id,
      otherProjectTask.id,
    ]);

    expect(journal.beginQueuedTaskExecution(firstTask.id, "2026-09-03T14:04:00.000Z")).toMatchObject({
      status: "EXECUTING",
    });
    expect(() => journal.beginQueuedTaskExecution(firstTask.id)).toThrow(AgentJournalConflictError);
    expect(journal.completeTaskExecution(firstTask.id, "DONE", "2026-09-03T14:05:00.000Z")).toMatchObject({
      status: "DONE",
    });
  });

  it("auto-resumes turn-limit tasks without resuming unscheduled five-hour limits", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const turnLimitTask = journal.createTask({
      id: "turn-limit-task",
      projectId: project.id,
      taskNumber: 1,
      title: "Turn limit",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 1,
      now: "2026-09-03T14:00:00.000Z",
    });
    const fiveHourTask = journal.createTask({
      id: "five-hour-task",
      projectId: project.id,
      taskNumber: 2,
      title: "Five hour",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 2,
      now: "2026-09-03T14:01:00.000Z",
    });
    journal.completeTaskExecution(turnLimitTask.id, "READY_TO_RESUME", "2026-09-03T14:02:00.000Z", {
      failureCode: "max_turns",
    });
    journal.completeTaskExecution(fiveHourTask.id, "READY_TO_RESUME", "2026-09-03T14:03:00.000Z", {
      failureCode: "five_hour",
    });

    expect(journal.listRunnableQueuedTasks(10, false, "2026-09-03T14:04:00.000Z")).toEqual([]);
    expect(journal.listRunnableQueuedTasks(10, true, "2026-09-03T14:04:00.000Z")).toMatchObject([
      { id: turnLimitTask.id, status: "READY_TO_RESUME" },
    ]);
  });

  it("aggregates project statistics from tasks, events, and specs", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const reviewTask = journal.createTask({
      id: "task-review",
      projectId: project.id,
      taskNumber: 1,
      title: "Review",
      status: "DESIGN_REVIEW",
      provider: "claude",
      workflow: "superpowers",
      position: 1,
      now: "2026-09-03T14:00:00.000Z",
    });
    const doneTask = journal.createTask({
      id: "task-done",
      projectId: project.id,
      taskNumber: 2,
      title: "Done",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 2,
      now: "2026-09-03T14:01:00.000Z",
    });
    journal.beginQueuedTaskExecution(doneTask.id, "2026-09-03T14:10:00.000Z");
    journal.completeTaskExecution(doneTask.id, "DONE", "2026-09-03T14:40:00.000Z");
    const queuedTask = journal.createTask({
      id: "task-queued",
      projectId: project.id,
      taskNumber: 3,
      title: "Queued",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 3,
      now: "2026-09-03T14:02:00.000Z",
    });
    journal.createTask({
      id: "task-failed",
      projectId: project.id,
      taskNumber: 4,
      title: "Failed",
      status: "FAILED",
      provider: "claude",
      workflow: "superpowers",
      position: 4,
      now: "2026-09-03T14:03:00.000Z",
    });
    const session = journal.createSession({
      id: "session-review",
      taskId: reviewTask.id,
      provider: "claude",
      type: "BRAINSTORM",
      status: "ENDED",
      createdAt: "2026-09-03T14:00:00.000Z",
    });
    journal.appendEvent({
      eventId: "event-review",
      schemaVersion: 1,
      occurredAt: "2026-09-03T14:05:00.000Z",
      projectId: project.id,
      taskId: reviewTask.id,
      sessionId: session.id,
      sequence: 1,
      persistence: "DURABLE",
      payload: { type: "session_started" },
    });
    journal.appendEvent({
      eventId: "event-usage-old",
      schemaVersion: 1,
      occurredAt: "2026-09-03T14:05:10.000Z",
      projectId: project.id,
      taskId: reviewTask.id,
      sessionId: session.id,
      sequence: 2,
      persistence: "DURABLE",
      payload: {
        type: "usage_updated",
        usage: {
          totalCostUsd: 0.01,
          inputTokens: 100,
          outputTokens: 20,
          thinkingTokens: 0,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
          webSearchRequests: 0,
          modelUsage: {
            sonnet: {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadInputTokens: 10,
              cacheCreationInputTokens: 5,
              webSearchRequests: 0,
              costUsd: 0.01,
            },
          },
        },
      },
    });
    journal.appendEvent({
      eventId: "event-usage-latest",
      schemaVersion: 1,
      occurredAt: "2026-09-03T14:05:20.000Z",
      projectId: project.id,
      taskId: reviewTask.id,
      sessionId: session.id,
      sequence: 3,
      persistence: "DURABLE",
      payload: {
        type: "usage_updated",
        usage: {
          totalCostUsd: 0.03,
          inputTokens: 200,
          outputTokens: 60,
          thinkingTokens: 12,
          cacheReadInputTokens: 40,
          cacheCreationInputTokens: 8,
          webSearchRequests: 1,
          modelUsage: {
            sonnet: {
              inputTokens: 200,
              outputTokens: 60,
              thinkingTokens: 12,
              cacheReadInputTokens: 40,
              cacheCreationInputTokens: 8,
              webSearchRequests: 1,
              costUsd: 0.03,
            },
          },
        },
      },
    });
    journal.appendEvent({
      eventId: "event-context",
      schemaVersion: 1,
      occurredAt: "2026-09-03T14:05:30.000Z",
      projectId: project.id,
      taskId: reviewTask.id,
      sessionId: session.id,
      sequence: 4,
      persistence: "DURABLE",
      payload: {
        type: "context_updated",
        context: {
          model: "claude-sonnet-4",
          totalTokens: 50000,
          maxTokens: 200000,
          percentage: 25,
        },
      },
    });
    journal.createTaskSpec({
      id: "spec-review",
      taskId: queuedTask.id,
      contentMarkdown: "# Spec",
      sha256: "sha",
      createdAt: "2026-09-03T14:04:00.000Z",
    });

    expect(journal.getProjectStats(project.id)).toMatchObject({
      projectId: project.id,
      totalTasks: 4,
      attentionTasks: 1,
      queuedTasks: 1,
      completedTasks: 1,
      failedTasks: 1,
      eventCount: 4,
      specCount: 1,
      completionRate: 25,
      totalCompletedDurationSeconds: 1800,
      averageCompletedDurationSeconds: 1800,
      costPerCompletedHourUsd: 0.06,
      latestActivityAt: "2026-09-03T14:40:00.000Z",
      usage: {
        totalCostUsd: 0.03,
        inputTokens: 200,
        outputTokens: 60,
        thinkingTokens: 12,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 8,
        webSearchRequests: 1,
        sessions: 1,
        latestContext: {
          model: "claude-sonnet-4",
          totalTokens: 50000,
          maxTokens: 200000,
          percentage: 25,
        },
      },
      byStatus: {
        DESIGN_REVIEW: 1,
        DONE: 1,
        QUEUED: 1,
        FAILED: 1,
      },
    });
  });

  it("enforces project ownership before creating tasks", () => {
    expect(() =>
      journal.createTask({
        id: "task-1",
        projectId: "missing-project",
        taskNumber: 1,
        title: "Missing project",
        status: "QUEUED",
        provider: "claude",
        workflow: "superpowers",
        position: 1,
        now: "2026-09-03T14:00:00.000Z",
      }),
    ).toThrow(AgentJournalConflictError);
  });

  it("enforces unique event sequence per session", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = "2026-09-03T14:00:00.000Z";
    const task = journal.createTask({
      id: "task-1",
      projectId: project.id,
      taskNumber: 1,
      title: "Add journal",
      status: "QUEUED",
      provider: "claude",
      workflow: "superpowers",
      position: 1,
      now,
    });
    const session = journal.createSession({
      id: "session-1",
      taskId: task.id,
      provider: "claude",
      type: "BRAINSTORM",
      status: "ACTIVE",
      createdAt: now,
    });

    const envelope = {
      eventId: "event-1",
      schemaVersion: 1 as const,
      occurredAt: "2026-09-03T14:00:01.000Z",
      projectId: project.id,
      taskId: task.id,
      sessionId: session.id,
      sequence: 1,
      persistence: "DURABLE" as const,
      payload: { type: "session_started" as const },
    };
    journal.appendEvent(envelope);

    expect(() => journal.appendEvent({ ...envelope, eventId: "event-2" })).toThrow(
      AgentJournalConflictError,
    );
  });

  it("rejects invalid lifecycle states before writing", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });

    expect(() =>
      journal.createTask({
        id: "task-1",
        projectId: project.id,
        taskNumber: 1,
        title: "Invalid task",
        status: "RUNNING" as never,
        provider: "claude",
        workflow: "superpowers",
        position: 1,
        now: "2026-09-03T14:00:00.000Z",
      }),
    ).toThrow(TaskValidationError);
  });
});
