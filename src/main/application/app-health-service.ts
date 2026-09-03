import type { AppHealth } from "../../shared/app";
import { workflowIds } from "../../shared/projects";
import { ProviderRegistry } from "../providers/provider-registry";

const workflowNames = {
  superpowers: "Superpowers",
} as const;

export class AppHealthService {
  constructor(private readonly providers: ProviderRegistry) {}

  async getHealth(): Promise<AppHealth> {
    return {
      phase: "phase-2-foundation",
      providers: await this.providers.health(),
      workflows: workflowIds.map((id) => ({
        id,
        displayName: workflowNames[id],
        configured: true,
        available: false,
        message: "Workflow adapter will be enabled with the provider integration.",
      })),
    };
  }
}
