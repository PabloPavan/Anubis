import type { AgentCapabilities } from "../../shared/app";
import type { ConversationImageAttachment } from "../../shared/app";
import type { AgentEvent } from "../../shared/agent-events";
import type { ProviderId } from "../../shared/projects";
import type { AgentEffortOption, AgentModelOption } from "../../shared/tasks";

export interface ProviderSessionRef {
  provider: ProviderId;
  providerSessionId: string;
}

export type AgentPromptContent = string | { text: string; images: ConversationImageAttachment[] };

export interface StartSessionInput {
  cwd: string;
  prompt: AgentPromptContent;
  metadata: Record<string, string>;
  interactive?: boolean;
  maxTurns?: number;
  model?: AgentModelOption;
  effort?: AgentEffortOption;
  toolMode?: "readOnly" | "edit";
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
}

export interface ResumeSessionInput {
  session: ProviderSessionRef;
  cwd?: string;
  prompt?: AgentPromptContent;
  interactive?: boolean;
  maxTurns?: number;
  model?: AgentModelOption;
  effort?: AgentEffortOption;
  toolMode?: "readOnly" | "edit";
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
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
