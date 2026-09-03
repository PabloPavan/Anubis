import { randomUUID } from "node:crypto";
import type { ClaudeDemoResult } from "../../shared/app";
import { parseProjectId } from "../../shared/projects";
import type { AgentSession, ExecutionAttempt, Task } from "../../shared/tasks";
import { AgentJournalRepository } from "../repositories/agent-journal-repository";
import { ProjectRepository } from "../repositories/project-repository";
import { ProviderRegistry } from "../providers/provider-registry";
import { ProviderUnavailableError } from "../providers/agent-provider";

const demoPrompt = [
  "This is an Anubis integration smoke test.",
  "Do not modify files.",
  "Reply exactly: ANUBIS_PROJECT_READY",
].join("\n");

export class ClaudeDemoService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly journal: AgentJournalRepository,
    private readonly providers: ProviderRegistry,
  ) {}

  async run(projectIdInput: unknown): Promise<ClaudeDemoResult> {
    const projectId = parseProjectId(projectIdInput);
    const project = this.projects.get(projectId);
    const provider = this.providers.get("claude");
    if (!provider) throw new ProviderUnavailableError("Claude provider is not registered.");

    const now = new Date().toISOString();
    const started = await provider.startSession({
      cwd: project.path,
      prompt: demoPrompt,
      metadata: { purpose: "smoke-test", projectId: project.id },
    });

    let task: Task;
    let attempt: ExecutionAttempt;
    let session: AgentSession;
    try {
      task = this.journal.createTask({
        id: randomUUID(),
        projectId: project.id,
        taskNumber: this.journal.nextTaskNumber(project.id),
        title: "Claude SDK smoke test",
        description: "Internal task created by Anubis to validate the Claude Agent SDK integration.",
        status: "EXECUTING",
        provider: "claude",
        workflow: "superpowers",
        position: 0,
        now,
      });
      attempt = this.journal.createExecutionAttempt({
        id: randomUUID(),
        taskId: task.id,
        attemptNumber: 1,
        status: "EXECUTING",
        startedAt: now,
      });
      session = this.journal.createSession({
        id: randomUUID(),
        taskId: task.id,
        attemptId: attempt.id,
        provider: "claude",
        providerSessionId: started.session.providerSessionId,
        type: "EXECUTION",
        status: "ACTIVE",
        createdAt: now,
      });
    } catch (error) {
      await provider.cancel(started.session, "Failed to persist Claude demo metadata.");
      throw error;
    }

    let sequence = 0;
    let summary = "";
    for await (const event of provider.events(started.session, new AbortController().signal)) {
      sequence += 1;
      if (event.type === "completed" && event.summary) summary = event.summary;
      this.journal.appendEvent({
        eventId: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        projectId: project.id,
        taskId: task.id,
        sessionId: session.id,
        sequence,
        persistence: "DURABLE",
        payload: event,
      });
    }

    return {
      taskId: task.id,
      attemptId: attempt.id,
      sessionId: session.id,
      providerSessionId: started.session.providerSessionId,
      eventCount: this.journal.countEventsForSession(session.id),
      summary,
    };
  }
}
