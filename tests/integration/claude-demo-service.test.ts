import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeDemoService } from "../../src/main/application/claude-demo-service";
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

class FakeClaudeProvider implements AgentProvider {
  readonly id = "claude";
  readonly displayName = "Claude Test";

  async startSession(_input: StartSessionInput): Promise<{ session: ProviderSessionRef }> {
    return { session: { provider: "claude", providerSessionId: "provider-session-1" } };
  }

  async resumeSession(input: ResumeSessionInput): Promise<{ session: ProviderSessionRef }> {
    return { session: input.session };
  }

  async sendMessage(_session: ProviderSessionRef, _message: string): Promise<void> {}

  async *events(_session: ProviderSessionRef, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "session_started" };
    yield { type: "completed", summary: "ANUBIS_PROJECT_READY" };
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

describe("claude demo service", () => {
  let directory: string;
  let database: DatabaseSync;
  let projects: ProjectService;
  let projectRepository: ProjectRepository;
  let journal: AgentJournalRepository;
  let service: ClaudeDemoService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "anubis-claude-demo-"));
    database = openDatabase(":memory:");
    projectRepository = new ProjectRepository(database);
    journal = new AgentJournalRepository(database);
    projects = new ProjectService(projectRepository);
    const providers = new ProviderRegistry();
    providers.register(new FakeClaudeProvider());
    service = new ClaudeDemoService(projectRepository, journal, providers);
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("runs a provider smoke test and persists normalized events", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });

    const result = await service.run(project.id);

    expect(result).toMatchObject({
      providerSessionId: "provider-session-1",
      eventCount: 3,
      summary: "ANUBIS_PROJECT_READY",
    });
    expect(journal.listEventsForSession(result.sessionId).map((event) => event.payload)).toEqual([
      { type: "session_started" },
      { type: "completed", summary: "ANUBIS_PROJECT_READY" },
      { type: "session_finished", outcome: "COMPLETED" },
    ]);
    expect(service.listSessionEvents(result.sessionId).map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
