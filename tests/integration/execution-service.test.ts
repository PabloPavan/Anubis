import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutionService } from "../../src/main/application/execution-service";
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

  async startSession(input: StartSessionInput): Promise<{ session: ProviderSessionRef }> {
    this.lastStartInput = input;
    return { session: { provider: "claude", providerSessionId: "execution-session-1" } };
  }

  async resumeSession(input: ResumeSessionInput): Promise<{ session: ProviderSessionRef }> {
    return { session: input.session };
  }

  async sendMessage(_session: ProviderSessionRef, _message: string): Promise<void> {}

  async *events(_session: ProviderSessionRef, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "session_started" };
    yield { type: "tool_started", callId: "edit-1", tool: "Edit", detail: "src/example.ts" };
    yield { type: "tool_finished", callId: "edit-1", tool: "Edit", detail: "src/example.ts" };
    yield { type: "completed", summary: "Implemented approved spec." };
    yield { type: "session_finished", outcome: "COMPLETED" };
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

describe("execution service", () => {
  let directory: string;
  let database: DatabaseSync;
  let projects: ProjectService;
  let projectRepository: ProjectRepository;
  let journal: AgentJournalRepository;
  let provider: FakeExecutionProvider;
  let service: ExecutionService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "anubis-execution-"));
    database = openDatabase(":memory:");
    projectRepository = new ProjectRepository(database);
    journal = new AgentJournalRepository(database);
    projects = new ProjectService(projectRepository);
    provider = new FakeExecutionProvider();
    const providers = new ProviderRegistry();
    providers.register(provider);
    service = new ExecutionService(projectRepository, journal, providers);
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
      cwd: directory,
      maxTurns: 20,
      metadata: { purpose: "execution", projectId: project.id, taskId: task.id },
      permissionMode: "acceptEdits",
      toolMode: "edit",
      prompt: expect.stringContaining(spec.contentMarkdown),
    });
    expect(result).toMatchObject({
      taskId: task.id,
      providerSessionId: "execution-session-1",
      eventCount: 5,
      summary: "Implemented approved spec.",
    });
    expect(journal.getTask(task.id)).toMatchObject({ status: "DONE" });
    expect(journal.listEventsForSession(result.sessionId).map((event) => event.payload.type)).toEqual([
      "session_started",
      "tool_started",
      "tool_finished",
      "completed",
      "session_finished",
    ]);
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
});
