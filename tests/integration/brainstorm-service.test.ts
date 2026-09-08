import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainstormService } from "../../src/main/application/brainstorm-service";
import type { NotificationSink } from "../../src/main/application/desktop-notification-service";
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
  lastResumeInput: ResumeSessionInput | null = null;
  startSummary = "Goals: inspect the sync path first.";
  resumeSummary = "Goals: inspect the sync path first.";

  async startSession(input: StartSessionInput): Promise<{ session: ProviderSessionRef }> {
    this.lastStartInput = input;
    return { session: { provider: "claude", providerSessionId: "brainstorm-session-1" } };
  }

  async resumeSession(input: ResumeSessionInput): Promise<{ session: ProviderSessionRef }> {
    this.lastResumeInput = input;
    return { session: { provider: "claude", providerSessionId: "brainstorm-session-2" } };
  }

  async sendMessage(_session: ProviderSessionRef, _message: string): Promise<void> {}

  async *events(_session: ProviderSessionRef, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    const summary = _session.providerSessionId === "brainstorm-session-2" ? this.resumeSummary : this.startSummary;
    yield { type: "session_started" };
    yield { type: "message_completed", messageId: "message-1", text: summary };
    yield { type: "completed", summary };
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

class FakeNotifications implements NotificationSink {
  calls: string[] = [];

  brainstormNeedsAnswer(_projectName: string, _task: unknown, _questionCount: number): void {
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

describe("brainstorm service", () => {
  let directory: string;
  let database: DatabaseSync;
  let projects: ProjectService;
  let projectRepository: ProjectRepository;
  let journal: AgentJournalRepository;
  let provider: FakeClaudeProvider;
  let notifications: FakeNotifications;
  let service: BrainstormService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "anubis-brainstorm-"));
    database = openDatabase(":memory:");
    projectRepository = new ProjectRepository(database);
    journal = new AgentJournalRepository(database);
    projects = new ProjectService(projectRepository);
    provider = new FakeClaudeProvider();
    notifications = new FakeNotifications();
    const providers = new ProviderRegistry();
    providers.register(provider);
    service = new BrainstormService(projectRepository, journal, providers, notifications);
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
      spec: expect.objectContaining({
        version: 1,
        contentMarkdown: "Goals: inspect the sync path first.",
      }),
    });
    expect(provider.lastStartInput).toMatchObject({
      cwd: directory,
      maxTurns: 6,
      metadata: { purpose: "brainstorm", projectId: project.id },
    });
    expect(provider.lastStartInput?.prompt).toContain("Task title: Review sync reliability");
    expect(provider.lastStartInput?.prompt).toContain("Use the Superpowers workflow/plugin for this brainstorm.");
    expect(provider.lastStartInput?.prompt).toContain("If Superpowers exposes a brainstorm/design skill");
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
      status: "ENDED",
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
        latestSessionStatus: "ENDED",
        latestSpecVersion: 1,
        eventCount: 3,
      }),
    ]);
    expect(service.getLatestSpec(result.taskId)).toMatchObject({
      taskId: result.taskId,
      version: 1,
      contentMarkdown: "Goals: inspect the sync path first.",
    });
    expect(notifications.calls).toEqual(["brainstormReadyForReview"]);
  });

  it("passes attached images to the brainstorm provider", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });

    await service.start({
      projectId: project.id,
      title: "Review screenshot",
      description: "Use the attached UI screenshot as context.",
      images: [
        {
          name: "attention-modal.png",
          mediaType: "image/png",
          dataBase64: "aW1hZ2U=",
          sizeBytes: 512,
        },
      ],
    });

    expect(provider.lastStartInput?.prompt).toMatchObject({
      text: expect.stringContaining("Attached images:\n- attention-modal.png (image/png, 1 KB)"),
      images: [
        {
          name: "attention-modal.png",
          mediaType: "image/png",
          dataBase64: "aW1hZ2U=",
          sizeBytes: 512,
        },
      ],
    });
  });

  it("lists events across all sessions for a task", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const started = await service.start({
      projectId: project.id,
      title: "Multi session task",
      description: "Start and then revise.",
    });
    provider.resumeSummary = "Updated spec after review feedback.";

    await service.revise({
      taskId: started.taskId,
      feedback: "Tighten the scope.",
    });

    expect(service.listTaskEvents(started.taskId).map((event) => event.sessionId)).toEqual([
      started.sessionId,
      started.sessionId,
      started.sessionId,
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
  });

  it("rejects empty brainstorm input", async () => {
    await expect(service.start({ projectId: "project-1", title: "", description: "x" })).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });

  it("approves a design review into the queue", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const result = await service.start({
      projectId: project.id,
      title: "Queue reviewed work",
      description: "Approve this brainstorm.",
    });

    const reviewed = service.reviewTask({ taskId: result.taskId, decision: "approve" });

    expect(reviewed).toMatchObject({
      id: result.taskId,
      projectId: project.id,
      status: "QUEUED",
      latestSessionStatus: "ENDED",
      latestSpecApprovedAt: expect.any(String),
    });
    expect(service.listTasks(project.id)[0]).toMatchObject({ id: result.taskId, status: "QUEUED" });
  });

  it("uses feedback to revise a brainstorm and write a new stored spec", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const first = await service.start({
      projectId: project.id,
      title: "Revise via feedback",
      description: "Ask for a better spec.",
    });

    const revised = await service.revise({
      taskId: first.taskId,
      feedback: "Please include retry backoff risks.",
    });

    expect(provider.lastResumeInput).toMatchObject({
      cwd: directory,
      maxTurns: 6,
      prompt: expect.stringContaining("Please include retry backoff risks."),
      session: { provider: "claude", providerSessionId: "brainstorm-session-1" },
    });
    expect(revised).toMatchObject({
      taskId: first.taskId,
      providerSessionId: "brainstorm-session-2",
      eventCount: 3,
      spec: expect.objectContaining({ version: 2 }),
    });
    expect(service.getLatestSpec(first.taskId)).toMatchObject({
      version: 2,
      sourceSessionId: revised.sessionId,
      contentMarkdown: "Goals: inspect the sync path first.",
    });
  });

  it("waits for brainstorm answers and resumes with the selected answer", async () => {
    provider.startSummary = [
      "### Perguntas",
      "1. **Where should the generated spec be stored?**",
      "- Anubis SQLite",
      "- Project markdown",
      "- Both places",
    ].join("\n");
    provider.resumeSummary = "## Spec\nStore the brainstorm spec in Anubis SQLite.";
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });

    const started = await service.start({
      projectId: project.id,
      title: "Choose spec storage",
      description: "Decide where brainstorm output should live.",
    });

    expect(started).toMatchObject({
      providerSessionId: "brainstorm-session-1",
      eventCount: 4,
      summary: provider.startSummary,
    });
    expect(started.spec).toBeUndefined();
    expect(journal.getTask(started.taskId)).toMatchObject({ status: "WAITING_USER" });
    expect(notifications.calls).toEqual(["brainstormNeedsAnswer"]);
    const waitingTask = service.listTasks(project.id)[0];
    expect(waitingTask).toMatchObject({
      id: started.taskId,
      status: "WAITING_USER",
      pendingQuestions: [
        expect.objectContaining({
          prompt: "Where should the generated spec be stored?",
          options: ["Anubis SQLite", "Project markdown", "Both places"],
        }),
      ],
    });
    expect(service.getLatestSpec(started.taskId)).toBeNull();

    const question = waitingTask?.pendingQuestions[0];
    expect(question).toBeDefined();
    const answered = await service.answerQuestion({
      taskId: started.taskId,
      questionId: question?.id,
      answer: "Anubis SQLite",
    });

    expect(provider.lastResumeInput).toMatchObject({
      cwd: directory,
      maxTurns: 6,
      prompt: expect.stringContaining('Answer to "Where should the generated spec be stored?": Anubis SQLite'),
      session: { provider: "claude", providerSessionId: "brainstorm-session-1" },
    });
    expect(answered).toMatchObject({
      taskId: started.taskId,
      providerSessionId: "brainstorm-session-2",
      eventCount: 3,
      spec: expect.objectContaining({
        version: 1,
        contentMarkdown: "## Spec\nStore the brainstorm spec in Anubis SQLite.",
      }),
    });
    expect(service.listTasks(project.id)[0]).toMatchObject({
      id: started.taskId,
      status: "DESIGN_REVIEW",
      latestSpecVersion: 1,
      pendingQuestions: [],
    });
    expect(notifications.calls).toEqual(["brainstormNeedsAnswer", "brainstormReadyForReview"]);
  });

  it("extracts loose brainstorm questions from a draft spec", async () => {
    provider.startSummary = [
      "# Spec (rascunho de teste) - Task #6: Teste de brainstorm 1",
      "",
      "## Recommended next step",
      "Simular a primeira pergunta de esclarecimento real sobre a feature ficticia.",
      "",
      "---",
      "",
      '**Pergunta de teste #3 (simulando a feature ficticia "TWMA"):**',
      "",
      "Sobre esse indicador ficticio de Media Movel Tripla Ponderada - qual",
      "seria o objetivo dele em relacao aos indicadores de media movel ja",
      "existentes?",
      "",
      "a) Reduzir lag mantendo suavizacao (variacao de calculo de pesos)",
      "b) Apenas variar a formula por completude de portfolio de indicadores",
      "c) Nao importa o conteudo - so quero ver mais uma rodada de",
      "   pergunta/resposta antes de encerrar o teste",
    ].join("\n");
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });

    const started = await service.start({
      projectId: project.id,
      title: "Loose question format",
      description: "Test a question embedded inside a markdown spec.",
    });

    const waitingTask = service.listTasks(project.id)[0];
    expect(started.spec).toBeUndefined();
    expect(waitingTask).toMatchObject({
      id: started.taskId,
      status: "WAITING_USER",
      pendingQuestions: [
        expect.objectContaining({
          prompt:
            "Sobre esse indicador ficticio de Media Movel Tripla Ponderada - qual seria o objetivo dele em relacao aos indicadores de media movel ja existentes?",
          options: [
            "Reduzir lag mantendo suavizacao (variacao de calculo de pesos)",
            "Apenas variar a formula por completude de portfolio de indicadores",
            "Nao importa o conteudo - so quero ver mais uma rodada de pergunta/resposta antes de encerrar o teste",
          ],
        }),
      ],
    });
  });

  it("discovers pending questions from an existing stored spec without duplicating them", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const now = new Date().toISOString();
    const task = journal.createTask({
      id: randomUUID(),
      projectId: project.id,
      taskNumber: journal.nextTaskNumber(project.id),
      title: "Existing review with embedded question",
      description: "Question was saved as markdown before structured extraction existed.",
      status: "DESIGN_REVIEW",
      provider: "claude",
      workflow: "superpowers",
      position: 0,
      now,
    });
    const session = journal.createSession({
      id: randomUUID(),
      taskId: task.id,
      provider: "claude",
      providerSessionId: "brainstorm-session-existing",
      type: "BRAINSTORM",
      status: "ENDED",
      createdAt: now,
    });
    const contentMarkdown = [
      "# Spec",
      "",
      "**Pergunta de teste #3:**",
      "",
      "Qual caminho seguir?",
      "",
      "a) Continuar simulando",
      "b) Encerrar",
    ].join("\n");
    journal.createTaskSpec({
      id: randomUUID(),
      taskId: task.id,
      contentMarkdown,
      sha256: createHash("sha256").update(contentMarkdown).digest("hex"),
      sourceSessionId: session.id,
      createdAt: now,
    });

    const firstLoad = service.listTasks(project.id)[0];
    const secondLoad = service.listTasks(project.id)[0];

    expect(firstLoad).toMatchObject({
      id: task.id,
      status: "WAITING_USER",
      pendingQuestions: [
        expect.objectContaining({
          prompt: "Qual caminho seguir?",
          options: ["Continuar simulando", "Encerrar"],
        }),
      ],
    });
    expect(secondLoad?.pendingQuestions).toHaveLength(1);
    expect(journal.listEventsForTask(task.id).filter((event) => event.payload.type === "question_asked")).toHaveLength(1);
  });

  it("returns a design review to draft when changes are needed", async () => {
    const project = await projects.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });
    const result = await service.start({
      projectId: project.id,
      title: "Revise reviewed work",
      description: "This needs another pass.",
    });

    const reviewed = service.reviewTask({ taskId: result.taskId, decision: "changes" });

    expect(reviewed).toMatchObject({ id: result.taskId, status: "DRAFT" });
    expect(() => service.reviewTask({ taskId: result.taskId, decision: "approve" })).toThrow(InputValidationError);
  });
});
