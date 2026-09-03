import type { ProviderId, WorkflowId } from "./projects";

export interface AgentCapabilities {
  streaming: boolean;
  cancellation: boolean;
  resume: boolean;
  structuredQuestions: boolean;
  subagentEvents: boolean;
}

export interface ProviderHealth {
  id: ProviderId;
  displayName: string;
  configured: boolean;
  available: boolean;
  capabilities: AgentCapabilities;
  message?: string;
}

export interface WorkflowHealth {
  id: WorkflowId;
  displayName: string;
  configured: boolean;
  available: boolean;
  message?: string;
}

export interface AppHealth {
  phase: "phase-2-foundation";
  providers: ProviderHealth[];
  workflows: WorkflowHealth[];
}

export interface AppApi {
  getHealth(): Promise<AppHealth>;
}
