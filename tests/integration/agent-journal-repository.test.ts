import { mkdtemp, rm } from "node:fs/promises";
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
