import { access } from "node:fs/promises";
import { join } from "node:path";
import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCapabilities } from "../../../shared/app";
import type { AgentEvent } from "../../../shared/agent-events";
import type {
  AgentProvider,
  ProviderSessionRef,
  ResumeSessionInput,
  ResumedAgentSession,
  StartedAgentSession,
  StartSessionInput,
} from "../agent-provider";
import { ProviderUnavailableError } from "../agent-provider";
import { mapClaudeMessage } from "./claude-event-mapper";

interface ActiveClaudeSession {
  controller: AbortController;
  query: Query;
  pending: SDKMessage[];
}

export interface ClaudeProviderOptions {
  executablePath?: string;
}

const capabilities: AgentCapabilities = Object.freeze({
  streaming: true,
  cancellation: true,
  resume: true,
  structuredQuestions: false,
  subagentEvents: true,
});

const defaultAllowedTools = ["Read", "Glob", "Grep", "LS"];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultExecutablePath(): Promise<string | undefined> {
  if (process.env.ANUBIS_CLAUDE_EXECUTABLE) return process.env.ANUBIS_CLAUDE_EXECUTABLE;
  if (process.platform !== "win32") return undefined;

  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return undefined;

  const localClaude = join(userProfile, ".local", "bin", "claude.exe");
  return (await exists(localClaude)) ? localClaude : undefined;
}

function sessionId(message: SDKMessage): string | undefined {
  return "session_id" in message && typeof message.session_id === "string" ? message.session_id : undefined;
}

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude";
  readonly displayName = "Claude";
  private readonly sessions = new Map<string, ActiveClaudeSession>();

  constructor(private readonly options: ClaudeProviderOptions = {}) {}

  async startSession(input: StartSessionInput): Promise<StartedAgentSession> {
    return this.openSession(input.prompt, { cwd: input.cwd });
  }

  async resumeSession(input: ResumeSessionInput): Promise<ResumedAgentSession> {
    return this.openSession(input.prompt ?? "Continue the previous session.", {
      resume: input.session.providerSessionId,
    });
  }

  async sendMessage(_session: ProviderSessionRef, _message: string): Promise<void> {
    throw new ProviderUnavailableError("Streaming input is not wired for Claude sessions yet.");
  }

  async *events(session: ProviderSessionRef, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const active = this.sessions.get(session.providerSessionId);
    if (!active) throw new ProviderUnavailableError("Claude session is not active.");

    if (signal.aborted) active.controller.abort(signal.reason);
    signal.addEventListener("abort", () => active.controller.abort(signal.reason), { once: true });

    try {
      for (const message of active.pending.splice(0)) {
        yield* mapClaudeMessage(message);
      }
      for await (const message of active.query) {
        yield* mapClaudeMessage(message);
      }
    } finally {
      this.sessions.delete(session.providerSessionId);
    }
  }

  async cancel(session: ProviderSessionRef, reason: string): Promise<void> {
    const active = this.sessions.get(session.providerSessionId);
    if (!active) return;
    active.controller.abort(reason);
  }

  capabilities(): AgentCapabilities {
    return capabilities;
  }

  async health(): Promise<{ available: boolean; message?: string }> {
    const executablePath = this.options.executablePath ?? (await defaultExecutablePath());
    if (executablePath && !(await exists(executablePath))) {
      return { available: false, message: `Claude executable was not found at ${executablePath}.` };
    }
    return {
      available: true,
      message: executablePath ? `Using ${executablePath}.` : "Using bundled Claude Agent SDK executable.",
    };
  }

  private async openSession(prompt: string, input: { cwd?: string; resume?: string }): Promise<StartedAgentSession> {
    const controller = new AbortController();
    const executablePath = this.options.executablePath ?? (await defaultExecutablePath());
    const options: Options = {
      abortController: controller,
      allowedTools: defaultAllowedTools,
      includePartialMessages: false,
      maxTurns: 1,
      permissionMode: "default",
      persistSession: true,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.resume ? { resume: input.resume } : {}),
      ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
    };
    const sdkQuery = query({ prompt, options });
    const first = await sdkQuery.next();
    if (first.done) throw new ProviderUnavailableError("Claude session ended before initialization.");

    const providerSessionId = sessionId(first.value);
    if (!providerSessionId) {
      controller.abort("Claude session did not provide a session_id.");
      throw new ProviderUnavailableError("Claude session did not provide a session_id.");
    }

    this.sessions.set(providerSessionId, {
      controller,
      query: sdkQuery,
      pending: [first.value],
    });

    return { session: { provider: this.id, providerSessionId } };
  }
}
