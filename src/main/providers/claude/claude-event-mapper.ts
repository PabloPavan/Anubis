import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, FailureClass } from "../../../shared/agent-events";

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

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function contentBlocks(message: SDKMessage): unknown[] {
  if (!("message" in message) || !isRecord(message.message) || !Array.isArray(message.message.content)) {
    return [];
  }
  return message.message.content;
}

function mapAssistant(message: SDKMessage): AgentEvent[] {
  const events: AgentEvent[] = [];
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
    events.push({
      type: "failed",
      classification: classify(message.error),
      error: { message: String(message.error), code: String(message.error) },
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
        return [
          {
            type: "subagent_started",
            subagentId: message.task_id,
            ...(message.subagent_type ? { role: message.subagent_type } : {}),
            ...(message.description ? { name: message.description } : {}),
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
      if (message.subtype === "success") {
        return [
          ...(message.result.trim() ? [{ type: "completed" as const, summary: message.result.trim() }] : []),
          { type: "session_finished", outcome: message.is_error ? "FAILED" : "COMPLETED" },
        ];
      }
      return [
        {
          type: "failed",
          classification: "PROVIDER",
          error: {
            message: message.errors.length > 0 ? message.errors.join("\n") : message.subtype,
            code: message.subtype,
          },
        },
        { type: "session_finished", outcome: "FAILED" },
      ];
    case "rate_limit_event":
      {
        const resetsAt = timestamp(message.rate_limit_info.resetsAt);
        return [
          {
            type: "rate_limit_updated",
            status: message.rate_limit_info.status,
            ...(message.rate_limit_info.rateLimitType ? { rateLimitType: message.rate_limit_info.rateLimitType } : {}),
            ...(resetsAt ? { resetsAt } : {}),
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
