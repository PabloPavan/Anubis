import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainstormService } from "../../src/main/application/brainstorm-service";
import { ProjectService } from "../../src/main/application/project-service";
import { openDatabase } from "../../src/main/database/database";
import type {
  AgentProvider,
  ProviderSessionRef,
  ResumeSessionInput,
  StartSessionInput,
} from "../../src/main/providers/agent-provider";
import { ProviderRegistry } from "../../src/main/providers/provider-registry";
import { AgentJournalRepository } from "../../src/main/repositories/agent-journal-repository";
import { ProjectRepository } from "../../src/main/repositories/project-repository";
import type { AgentEvent } from "../../src/shared/agent-events";
import type { AgentCapabilities } from "../../src/shared/app";
import { InputValidationError } from "../../src/shared/projects";

class FakeClaudeProvider implements AgentProvider {
  readonly id = "claude";
  readonly displayName = "Claude Test";
  lastStartInput: StartSessionInput | null = null;

  async startSession(input: StartSessionInput): Promise<{ session: ProviderSessionRef }> {
    this.lastStartInput = input;
    return { session: { provider: "claude", providerSessionId: "brainstorm-session-1" } };
  }

  async resumeSession(input: ResumeSessionInput): Promise<{ session: ProviderSessionRef }> {
    return { session: input.session };
  }

  async sendMessage(_session: ProviderSessionRef, _message: string): Promise<void> {}

  async *events(_session: ProviderSessionRef, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "session_started" };
    yield { type: "message_completed", messageId: "message-1", text: "Goals: inspect the sync path first." };
    yield { type: "completed", summary: "Goals: inspect the sync path first." };
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

describe("brainstorm service", () => {
  let directory: string;
  let database: DatabaseSync;
  let projects: ProjectService;
  let projectRepository: ProjectRepository;
  let journal: AgentJournalRepository;
  let provider: FakeClaudeProvider;
  let service: BrainstormService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "anubis-brainstorm-"));
    database = openDatabase(":memory:");
    projectRepository = new ProjectRepository(database);
    journal = new AgentJournalRepository(database);
    projects = new ProjectService(projectRepository);
    provider = new FakeClaudeProvider();
    const providers = new ProviderRegistry();
    providers.register(provider);
    service = new BrainstormService(projectRepository, journal, providers);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("starts a brainstorm session and persists the task and events", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });

    const result = await service.start({
      projectId: project.id,
      title: "Review sync reliability",
      description: "Find the best implementation direction for order sync retries.",
    });

    expect(result).toMatchObject({
      providerSessionId: "brainstorm-session-1",
      eventCount: 3,
      summary: "Goals: inspect the sync path first.",
    });
    expect(provider.lastStartInput).toMatchObject({
      cwd: directory,
      maxTurns: 6,
      metadata: { purpose: "brainstorm", projectId: project.id },
    });
    expect(provider.lastStartInput?.prompt).toContain("Task title: Review sync reliability");
    expect(journal.getTask(result.taskId)).toMatchObject({
      projectId: project.id,
      title: "Review sync reliability",
      status: "DESIGN_REVIEW",
      provider: "claude",
      workflow: "superpowers",
    });
    expect(journal.getSession(result.sessionId)).toMatchObject({
      taskId: result.taskId,
      providerSessionId: "brainstorm-session-1",
      type: "BRAINSTORM",
      status: "ACTIVE",
    });
    expect(service.listSessionEvents(result.sessionId).map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(service.listSessionEvents(result.sessionId).map((event) => event.payload.type)).toEqual([
      "session_started",
      "message_completed",
      "session_finished",
    ]);
    expect(service.listTasks(project.id)).toEqual([
      expect.objectContaining({
        id: result.taskId,
        projectId: project.id,
        taskNumber: 1,
        title: "Review sync reliability",
        status: "DESIGN_REVIEW",
        latestSessionId: result.sessionId,
        latestProviderSessionId: "brainstorm-session-1",
        eventCount: 3,
      }),
    ]);
  });

  it("rejects empty brainstorm input", async () => {
    await expect(service.start({ projectId: "project-1", title: "", description: "x" })).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});
