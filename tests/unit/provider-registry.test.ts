import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/shared/agent-events";
import type { AgentCapabilities } from "../../src/shared/app";
import type {
  AgentProvider,
  ProviderSessionRef,
  ResumeSessionInput,
  StartSessionInput,
} from "../../src/main/providers/agent-provider";
import { ProviderRegistry } from "../../src/main/providers/provider-registry";

const capabilities: AgentCapabilities = {
  streaming: true,
  cancellation: true,
  resume: false,
  structuredQuestions: true,
  subagentEvents: false,
};

class TestClaudeProvider implements AgentProvider {
  readonly id = "claude";
  readonly displayName = "Claude Test Adapter";

  async startSession(_input: StartSessionInput): Promise<{ session: ProviderSessionRef }> {
    return { session: { provider: this.id, providerSessionId: "provider-session-1" } };
  }

  async resumeSession(input: ResumeSessionInput): Promise<{ session: ProviderSessionRef }> {
    return { session: input.session };
  }

  async sendMessage(_session: ProviderSessionRef, _message: string): Promise<void> {}

  async *events(_session: ProviderSessionRef, _signal: AbortSignal): AsyncIterable<AgentEvent> {}

  async cancel(_session: ProviderSessionRef, _reason: string): Promise<void> {}

  capabilities(): AgentCapabilities {
    return capabilities;
  }

  async health(): Promise<{ available: boolean; message?: string }> {
    return { available: true };
  }
}

describe("provider registry", () => {
  it("reports configured provider ids as unavailable until an adapter is registered", async () => {
    const registry = new ProviderRegistry();

    await expect(registry.health()).resolves.toEqual([
      {
        id: "claude",
        displayName: "Claude",
        configured: false,
        available: false,
        capabilities: {
          streaming: false,
          cancellation: false,
          resume: false,
          structuredQuestions: false,
          subagentEvents: false,
        },
        message: "Provider adapter is not installed in this build.",
      },
    ]);
  });

  it("returns registered adapter capabilities and health", async () => {
    const registry = new ProviderRegistry();
    const provider = new TestClaudeProvider();

    registry.register(provider);

    await expect(registry.health()).resolves.toEqual([
      {
        id: "claude",
        displayName: "Claude Test Adapter",
        configured: true,
        available: true,
        capabilities,
      },
    ]);
    expect(registry.get("claude")).toBe(provider);
  });
});
