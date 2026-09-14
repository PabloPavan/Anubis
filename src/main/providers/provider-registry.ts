import type { AgentCapabilities, ProviderHealth } from "../../shared/app";
import { providerIds, type ProviderId } from "../../shared/projects";
import type { AgentProvider } from "./agent-provider";

const emptyCapabilities: AgentCapabilities = Object.freeze({
  streaming: false,
  cancellation: false,
  resume: false,
  structuredQuestions: false,
  subagentEvents: false,
});

const providerNames: Record<ProviderId, string> = {
  claude: "Claude",
  gemini: "Gemini",
};

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AgentProvider>();

  register(provider: AgentProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): AgentProvider | undefined {
    return this.providers.get(id);
  }

  async health(): Promise<ProviderHealth[]> {
    return Promise.all(providerIds.map((id) => this.providerHealth(id)));
  }

  private async providerHealth(id: ProviderId): Promise<ProviderHealth> {
    const provider = this.providers.get(id);
    if (!provider) {
      return {
        id,
        displayName: providerNames[id],
        configured: false,
        available: false,
        capabilities: emptyCapabilities,
        message: "Provider is unavailable.",
      };
    }

    const status = await provider.health();
    return {
      id,
      displayName: provider.displayName,
      configured: true,
      available: status.available,
      capabilities: provider.capabilities(),
      ...(status.message ? { message: status.message } : {}),
    };
  }
}
