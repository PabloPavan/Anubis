import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentModelUsage, AgentUsageSnapshot, FailureClass } from "../../../shared/agent-events";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function messageUuid(message: SDKMessage): string {
  return "uuid" in message && typeof message.uuid === "string" ? message.uuid : "unknown";
}

function classify(error: unknown): FailureClass {
  if (error === "authentication_failed" || error === "oauth_org_not_allowed") return "AUTH";
  if (error === "rate_limit" || error === "overloaded") return "RATE_LIMIT";
  if (error === "unknown") return "UNKNOWN";
  return "PROVIDER";
}

function failureCode(message: string, fallback: string): string {
  const normalized = `${fallback} ${message}`.toLowerCase();
  if (
    normalized.includes("error_max_turns") ||
    normalized.includes("max_turns") ||
    normalized.includes("max turns") ||
    normalized.includes("maximum number of turns")
  ) {
    return "max_turns";
  }
  return fallback;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mapModelUsage(value: unknown): Record<string, AgentModelUsage> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, AgentModelUsage]> = [];
  for (const [model, rawUsage] of Object.entries(value)) {
    if (!isRecord(rawUsage)) continue;
    entries.push([
      model,
      {
        inputTokens: numberValue(rawUsage.inputTokens) ?? 0,
        outputTokens: numberValue(rawUsage.outputTokens) ?? 0,
        ...(numberValue(rawUsage.thinkingTokens) !== undefined ? { thinkingTokens: numberValue(rawUsage.thinkingTokens)! } : {}),
        cacheReadInputTokens: numberValue(rawUsage.cacheReadInputTokens) ?? 0,
        cacheCreationInputTokens: numberValue(rawUsage.cacheCreationInputTokens) ?? 0,
        webSearchRequests: numberValue(rawUsage.webSearchRequests) ?? 0,
        costUsd: numberValue(rawUsage.costUSD) ?? 0,
        ...(numberValue(rawUsage.contextWindow) !== undefined ? { contextWindow: numberValue(rawUsage.contextWindow)! } : {}),
        ...(numberValue(rawUsage.maxOutputTokens) !== undefined ? { maxOutputTokens: numberValue(rawUsage.maxOutputTokens)! } : {}),
        ...(text(rawUsage.canonicalModel) ? { canonicalModel: text(rawUsage.canonicalModel)! } : {}),
        ...(text(rawUsage.provider) ? { provider: text(rawUsage.provider)! } : {}),
      },
    ]);
  }
  return Object.fromEntries(entries);
}

function usageSnapshot(message: SDKMessage): AgentUsageSnapshot | null {
  if (!("modelUsage" in message)) return null;
  const modelUsage = mapModelUsage(message.modelUsage);
  const totals = Object.values(modelUsage).reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      thinkingTokens: total.thinkingTokens + (usage.thinkingTokens ?? 0),
      cacheReadInputTokens: total.cacheReadInputTokens + usage.cacheReadInputTokens,
      cacheCreationInputTokens: total.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      webSearchRequests: total.webSearchRequests + usage.webSearchRequests,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
    },
  );
  return {
    totalCostUsd: "total_cost_usd" in message ? (numberValue(message.total_cost_usd) ?? 0) : 0,
    ...("duration_ms" in message && numberValue(message.duration_ms) !== undefined ? { totalDurationMs: numberValue(message.duration_ms)! } : {}),
    ...("duration_api_ms" in message && numberValue(message.duration_api_ms) !== undefined
      ? { totalApiDurationMs: numberValue(message.duration_api_ms)! }
      : {}),
    ...totals,
    modelUsage,
  };
}

function contextEvent(message: SDKMessage): AgentEvent | null {
  const rawMessage: unknown = message;
  const maybeContext = isRecord(rawMessage) ? rawMessage.context_usage : undefined;
  if (!isRecord(maybeContext)) return null;
  const model = text(maybeContext.model);
  const totalTokens = numberValue(maybeContext.total_tokens);
  const maxTokens = numberValue(maybeContext.raw_max_tokens);
  const percentage = numberValue(maybeContext.percentage);
  if (!model || totalTokens === undefined || maxTokens === undefined || percentage === undefined) return null;
  const overLimit = isRecord(maybeContext.over_limit) ? numberValue(maybeContext.over_limit.tokens_over) : undefined;
  return {
    type: "context_updated",
    context: {
      model,
      totalTokens,
      maxTokens,
      percentage,
      ...(overLimit !== undefined ? { tokensOver: overLimit } : {}),
    },
  };
}

function contentBlocks(message: SDKMessage): unknown[] {
  if (!("message" in message) || !isRecord(message.message) || !Array.isArray(message.message.content)) {
    return [];
  }
  return message.message.content;
}

function mapAssistant(message: SDKMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  const context = contextEvent(message);
  if (context) events.push(context);
  const rawMessage: Record<string, unknown> =
    "message" in message && isRecord(message.message) ? message.message : {};
  const messageId = text(rawMessage["id"]) ?? messageUuid(message);
  for (const block of contentBlocks(message)) {
    if (!isRecord(block)) continue;
    if (block.type === "text") {
      const value = text(block.text);
      if (value) {
        events.push({
          type: "message_completed",
          messageId,
          text: value,
        });
      }
    }
    if (block.type === "tool_use") {
      const id = text(block.id) ?? messageUuid(message);
      const name = text(block.name) ?? "unknown";
      events.push({ type: "tool_started", callId: id, tool: name });
    }
  }
  if ("error" in message && message.error) {
    const errorMessage = String(message.error);
    events.push({
      type: "failed",
      classification: classify(message.error),
      error: { message: errorMessage, code: failureCode(errorMessage, errorMessage) },
    });
  }
  return events;
}

function mapUser(message: SDKMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const block of contentBlocks(message)) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const callId = text(block.tool_use_id) ?? messageUuid(message);
    const failed = block.is_error === true;
    events.push(
      failed
        ? {
            type: "tool_failed",
            callId,
            tool: "unknown",
            error: { message: "Claude tool result reported an error." },
          }
        : { type: "tool_finished", callId, tool: "unknown" },
    );
  }
  return events;
}

export function mapClaudeMessage(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case "system":
      if ("subtype" in message && message.subtype === "init") return [{ type: "session_started" }];
      if ("subtype" in message && message.subtype === "status") {
        return message.status ? [{ type: "thinking_status", text: message.status }] : [];
      }
      if ("subtype" in message && message.subtype === "api_retry") {
        return [
          {
            type: "thinking_status",
            text: `Claude API retry ${message.attempt}/${message.max_retries}`,
          },
        ];
      }
      if ("subtype" in message && message.subtype === "task_started") {
        const role = text(message.subagent_type);
        const description = text(message.description);
        return [
          {
            type: "subagent_started",
            subagentId: message.task_id,
            ...(role ? { role } : {}),
            ...(description ? { description } : {}),
          },
        ];
      }
      if ("subtype" in message && message.subtype === "task_updated" && message.patch.status) {
        if (message.patch.status === "completed") {
          return [{ type: "subagent_finished", subagentId: message.task_id, outcome: "completed" }];
        }
        if (message.patch.status === "failed" || message.patch.status === "killed") {
          return [{ type: "subagent_finished", subagentId: message.task_id, outcome: message.patch.status }];
        }
      }
      return [];
    case "assistant":
      return mapAssistant(message);
    case "user":
      return mapUser(message);
    case "result":
      {
        const usage = usageSnapshot(message);
        const usageEvents = usage ? [{ type: "usage_updated" as const, usage }] : [];
      if (message.subtype === "success") {
        return [
          ...usageEvents,
          ...(message.result.trim() ? [{ type: "completed" as const, summary: message.result.trim() }] : []),
          { type: "session_finished", outcome: message.is_error ? "FAILED" : "COMPLETED" },
        ];
      }
      {
        const messageText = message.errors.length > 0 ? message.errors.join("\n") : message.subtype;
        return [
        ...usageEvents,
        {
          type: "failed",
          classification: "PROVIDER",
          error: {
            message: messageText,
            code: failureCode(messageText, message.subtype),
          },
        },
        { type: "session_finished", outcome: "FAILED" },
        ];
      }
      }
    case "rate_limit_event":
      {
        const resetsAt = timestamp(message.rate_limit_info.resetsAt);
        return [
          {
            type: "rate_limit_updated",
            status: message.rate_limit_info.status,
            ...(message.rate_limit_info.rateLimitType ? { rateLimitType: message.rate_limit_info.rateLimitType } : {}),
            ...(resetsAt ? { resetsAt } : {}),
            ...(numberValue(message.rate_limit_info.utilization) !== undefined
              ? { utilization: numberValue(message.rate_limit_info.utilization)! }
              : {}),
          },
          ...(message.rate_limit_info.status === "rejected"
            ? [
                {
                  type: "failed" as const,
                  classification: "RATE_LIMIT" as const,
                  error: {
                    message: "Claude rate limit reached.",
                    code: message.rate_limit_info.rateLimitType ?? "rate_limit",
                  },
                },
              ]
            : []),
        ];
      }
    case "auth_status":
      if (message.error) {
        return [{ type: "failed", classification: "AUTH", error: { message: message.error } }];
      }
      if (message.output.length === 0) return [];
      {
        const output = text(message.output[message.output.length - 1]);
        return output ? [{ type: "thinking_status", text: output }] : [];
      }
    case "tool_progress":
      return message.heartbeat ? [] : [{ type: "thinking_status", text: `${message.tool_name} running` }];
    default:
      return [];
  }
}
