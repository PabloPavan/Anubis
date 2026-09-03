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

const unavailableCapabilities: AgentCapabilities = Object.freeze({
  streaming: false,
  cancellation: false,
  resume: false,
  structuredQuestions: false,
  subagentEvents: false,
});

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude";
  readonly displayName = "Claude";

  async startSession(_input: StartSessionInput): Promise<StartedAgentSession> {
    throw new ProviderUnavailableError("Claude Agent SDK is not integrated in this build.");
  }

  async resumeSession(_input: ResumeSessionInput): Promise<ResumedAgentSession> {
    throw new ProviderUnavailableError("Claude Agent SDK is not integrated in this build.");
  }

  async sendMessage(_session: ProviderSessionRef, _message: string): Promise<void> {
    throw new ProviderUnavailableError("Claude Agent SDK is not integrated in this build.");
  }

  async *events(_session: ProviderSessionRef, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    throw new ProviderUnavailableError("Claude Agent SDK is not integrated in this build.");
  }

  async cancel(_session: ProviderSessionRef, _reason: string): Promise<void> {
    throw new ProviderUnavailableError("Claude Agent SDK is not integrated in this build.");
  }

  capabilities(): AgentCapabilities {
    return unavailableCapabilities;
  }

  async health(): Promise<{ available: boolean; message?: string }> {
    return {
      available: false,
      message: "Claude Agent SDK is not integrated in this build.",
    };
  }
}
