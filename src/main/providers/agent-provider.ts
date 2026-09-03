import type { AgentCapabilities } from "../../shared/app";
import type { AgentEvent } from "../../shared/agent-events";
import type { ProviderId } from "../../shared/projects";

export interface ProviderSessionRef {
  provider: ProviderId;
  providerSessionId: string;
}

export interface StartSessionInput {
  cwd: string;
  prompt: string;
  metadata: Record<string, string>;
}

export interface ResumeSessionInput {
  session: ProviderSessionRef;
  prompt?: string;
}

export interface StartedAgentSession {
  session: ProviderSessionRef;
}

export interface ResumedAgentSession {
  session: ProviderSessionRef;
}

export class ProviderUnavailableError extends Error {
  constructor(message = "Provider is not available.") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  startSession(input: StartSessionInput): Promise<StartedAgentSession>;
  resumeSession(input: ResumeSessionInput): Promise<ResumedAgentSession>;
  sendMessage(session: ProviderSessionRef, message: string): Promise<void>;
  events(session: ProviderSessionRef, signal: AbortSignal): AsyncIterable<AgentEvent>;
  cancel(session: ProviderSessionRef, reason: string): Promise<void>;
  capabilities(): AgentCapabilities;
  health(): Promise<{ available: boolean; message?: string }>;
}
