import type { AppHealth } from "../../shared/app";
import { workflowIds } from "../../shared/projects";
import { ProviderRegistry } from "../providers/provider-registry";
import { workflowDisplayNames } from "../workflows/workflow-registry";

export class AppHealthService {
  constructor(private readonly providers: ProviderRegistry) {}

  async getHealth(): Promise<AppHealth> {
    return {
      providers: await this.providers.health(),
      workflows: workflowIds.map((id) => ({
        id,
        displayName: workflowDisplayNames[id] ?? id,
        configured: true,
        available: true,
      })),
    };
  }
}
