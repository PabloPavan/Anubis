import { access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentCapabilities } from "../../../shared/app";
import type { AgentEvent } from "../../../shared/agent-events";
import type { AgentEffortOption, AgentModelOption } from "../../../shared/tasks";
import type {
  AgentPromptContent,
  AgentProvider,
  ProviderSessionRef,
  ResumeSessionInput,
  ResumedAgentSession,
  StartSessionInput,
  StartedAgentSession,
} from "../agent-provider";
import { ProviderUnavailableError } from "../agent-provider";

export interface GeminiProviderOptions {
  executablePath?: string;
  apiKey?: string;
  model?: string;
}

interface ActiveGeminiSession {
  controller: AbortController;
  events: AsyncIterable<AgentEvent>;
}

const capabilities: AgentCapabilities = Object.freeze({
  streaming: true,
  cancellation: true,
  resume: true,
  structuredQuestions: false,
  subagentEvents: true,
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultGeminiExecutable(): Promise<string | undefined> {
  if (process.env.ANUBIS_GEMINI_EXECUTABLE) return process.env.ANUBIS_GEMINI_EXECUTABLE;
  if (process.env.GEMINI_EXECUTABLE) return process.env.GEMINI_EXECUTABLE;
  if (process.platform !== "win32") return undefined;

  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return undefined;

  const candidates = [
    join(userProfile, "AppData", "Roaming", "Antigravity", "bin", "agy-node.cmd"),
    join(userProfile, ".local", "bin", "gemini.exe"),
    join(userProfile, "AppData", "Local", "Programs", "antigravity", "Antigravity.exe"),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

function defaultApiKey(): string | undefined {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return key && key !== "no" ? key : undefined;
}

export function resolveModelName(model?: AgentModelOption, effort?: AgentEffortOption): string {
  if (model && model !== "default") {
    if (model === "pro") return "gemini-2.5-pro";
    if (model === "flash") return "gemini-2.5-flash";
    if (model === "flash-lite") return "gemini-2.5-flash-lite";
    if (model === "opus" || model === "sonnet") return "gemini-2.5-pro";
    if (model === "haiku") return "gemini-2.5-flash";
    return model;
  }
  if (effort === "high" || effort === "xhigh" || effort === "max") {
    return "gemini-2.5-pro";
  }
  return "gemini-2.5-flash";
}

function extractPromptText(prompt: AgentPromptContent): string {
  return typeof prompt === "string" ? prompt : prompt.text;
}

export class GeminiProvider implements AgentProvider {
  readonly id = "gemini";
  readonly displayName = "Gemini";
  private readonly sessions = new Map<string, ActiveGeminiSession>();
  private readonly sessionPrompts = new Map<string, string[]>();

  constructor(private readonly options: GeminiProviderOptions = {}) {}

  async startSession(input: StartSessionInput): Promise<StartedAgentSession> {
    const health = await this.health();
    if (!health.available) {
      throw new ProviderUnavailableError(health.message ?? "Gemini is not configured.");
    }

    const providerSessionId = randomUUID();
    const controller = new AbortController();
    const promptText = extractPromptText(input.prompt);
    this.sessionPrompts.set(providerSessionId, [promptText]);

    const events = this.runAgentLoop({
      controller,
      promptText,
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
    });

    this.sessions.set(providerSessionId, { controller, events });
    return { session: { provider: this.id, providerSessionId } };
  }

  async resumeSession(input: ResumeSessionInput): Promise<ResumedAgentSession> {
    const health = await this.health();
    if (!health.available) {
      throw new ProviderUnavailableError(health.message ?? "Gemini is not configured.");
    }

    const previousId = input.session.providerSessionId;
    const history = this.sessionPrompts.get(previousId) ?? [];
    const promptText = input.prompt ? extractPromptText(input.prompt) : "Continue the previous task.";
    const updatedHistory = [...history, promptText];

    const providerSessionId = randomUUID();
    const controller = new AbortController();
    this.sessionPrompts.set(providerSessionId, updatedHistory);

    const events = this.runAgentLoop({
      controller,
      promptText: updatedHistory.join("\n\n---\n\n"),
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
    });

    this.sessions.set(providerSessionId, { controller, events });
    return { session: { provider: this.id, providerSessionId } };
  }

  async sendMessage(_session: ProviderSessionRef, _message: string): Promise<void> {
    throw new ProviderUnavailableError("Streaming input is not wired for Gemini sessions yet.");
  }

  async *events(session: ProviderSessionRef, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const active = this.sessions.get(session.providerSessionId);
    if (!active) throw new ProviderUnavailableError("Gemini session is not active.");

    if (signal.aborted) active.controller.abort(signal.reason);
    signal.addEventListener("abort", () => active.controller.abort(signal.reason), { once: true });

    try {
      yield* active.events;
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
    const executablePath = this.options.executablePath ?? (await defaultGeminiExecutable());
    const apiKey = this.options.apiKey ?? defaultApiKey();

    if (this.options.executablePath && !(await exists(this.options.executablePath))) {
      return { available: false, message: `Gemini executable was not found at ${this.options.executablePath}.` };
    }

    if (this.options.apiKey) {
      return {
        available: true,
        message: "Using configured Gemini API key.",
      };
    }

    if (executablePath) {
      return {
        available: true,
        message: `Using Gemini CLI at ${executablePath}.`,
      };
    }

    if (apiKey) {
      return {
        available: true,
        message: "Using configured Gemini API key.",
      };
    }

    return {
      available: false,
      message: "Gemini CLI executable or GEMINI_API_KEY was not found.",
    };
  }

  private async *runAgentLoop(params: {
    controller: AbortController;
    promptText: string;
    model?: AgentModelOption | undefined;
    effort?: AgentEffortOption | undefined;
    cwd?: string | undefined;
  }): AsyncIterable<AgentEvent> {
    const { controller, promptText, model, effort } = params;
    yield { type: "session_started" };

    if (controller.signal.aborted) {
      yield { type: "failed", classification: "CANCELLED", error: { message: "Session was cancelled." } };
      yield { type: "session_finished", outcome: "CANCELLED" };
      return;
    }

    const apiKey = this.options.apiKey ?? defaultApiKey();
    const selectedModel = this.options.model ?? resolveModelName(model, effort);

    if (apiKey) {
      if (!promptText.trim()) {
        yield {
          type: "failed",
          classification: "PROVIDER",
          error: { message: "Cannot start Gemini session with an empty prompt." },
        };
        yield { type: "session_finished", outcome: "FAILED" };
        return;
      }

      if (
        !/^gemini-/.test(selectedModel) &&
        selectedModel !== "pro" &&
        selectedModel !== "flash" &&
        selectedModel !== "flash-lite"
      ) {
        yield {
          type: "failed",
          classification: "PROVIDER",
          error: { message: `Unknown Gemini model: ${selectedModel}. Use gemini-X.X-{pro|flash|flash-lite} or an alias.` },
        };
        yield { type: "session_finished", outcome: "FAILED" };
        return;
      }

      yield { type: "thinking_status", text: `Consulting ${selectedModel}...` };
      try {
        const requestBody: Record<string, unknown> = {
          contents: [{ parts: [{ text: promptText }] }],
        };
        if (effort && effort !== "default") {
          // Map effort levels to Gemini thinking budget (in tokens).
          // Gemini documentation: https://ai.google.dev/api/rest/v1beta/models/generateContent#ThinkingConfig
          // - off (0): Disable extended thinking
          // - low (1024): Minimal reasoning, fast responses
          // - medium (8192): Balanced reasoning and latency
          // - high/xhigh/max (24576): Maximum reasoning depth (maps to single high budget tier)
          const thinkingBudget =
            effort === "off"
              ? 0
              : effort === "low"
                ? 1024
                : effort === "medium"
                  ? 8192
                  : 24576; // high, xhigh, max all map to max budget
          requestBody.generationConfig = {
            thinkingConfig: {
              thinkingBudget,
            },
          };
        }

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const errorBody = await response.text();
          const retryAfter = response.headers.get("Retry-After");
          const error: { message: string; retryAfterSeconds?: number } = {
            message: `Gemini API error (${response.status}): ${errorBody}`,
          };
          if (response.status === 429 && retryAfter) {
            error.retryAfterSeconds = isNaN(Number(retryAfter))
              ? Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000)
              : Number(retryAfter);
          }
          yield {
            type: "failed",
            classification: response.status === 401 || response.status === 403 ? "AUTH" : response.status === 429 ? "RATE_LIMIT" : "PROVIDER",
            error,
          };
          yield { type: "session_finished", outcome: "FAILED" };
          return;
        }

        const data = (await response.json()) as {
          error?: { message?: string };
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };

        if (data.error) {
          yield {
            type: "failed",
            classification: "PROVIDER",
            error: { message: `Gemini API error: ${data.error.message ?? "Unknown error"}` },
          };
          yield { type: "session_finished", outcome: "FAILED" };
          return;
        }

        const textContent = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";

        if (!textContent.trim()) {
          yield {
            type: "failed",
            classification: "PROVIDER",
            error: { message: "Gemini API returned empty response. This may indicate an invalid model or request." },
          };
          yield { type: "session_finished", outcome: "FAILED" };
          return;
        }

        const messageId = randomUUID();
        yield { type: "message_completed", messageId, text: textContent.trim() };
        yield { type: "completed", summary: textContent.trim() };
        yield { type: "session_finished", outcome: "COMPLETED" };
      } catch (error) {
        if (controller.signal.aborted) {
          yield { type: "failed", classification: "CANCELLED", error: { message: "Session was cancelled." } };
          yield { type: "session_finished", outcome: "CANCELLED" };
        } else {
          yield {
            type: "failed",
            classification: "PROVIDER",
            error: { message: error instanceof Error ? error.message : "Gemini session failed." },
          };
          yield { type: "session_finished", outcome: "FAILED" };
        }
      }
      return;
    }

    // CLI or local execution fallback
    throw new ProviderUnavailableError(
      "Gemini CLI session support is not yet implemented. Please configure GEMINI_API_KEY to use the Gemini REST API.",
    );
  }
}
