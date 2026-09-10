import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { parseAgentEvent } from "../../src/shared/agent-events";
import { mapClaudeMessage } from "../../src/main/providers/claude/claude-event-mapper";

describe("claude event mapper", () => {
  it("preserves long subagent descriptions before validation", () => {
    const description = "x".repeat(400);
    const events = mapClaudeMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      subagent_type: "general-purpose",
      description,
    } as unknown as SDKMessage);

    const [event] = events;
    expect(event).toMatchObject({
      type: "subagent_started",
      subagentId: "task-1",
      role: "general-purpose",
      description,
    });
    expect(() => parseAgentEvent(event)).not.toThrow();
  });

  it("maps result model usage into a durable usage event", () => {
    const [usageEvent] = mapClaudeMessage({
      type: "result",
      subtype: "success",
      duration_ms: 1200,
      duration_api_ms: 900,
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: null,
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      },
      modelUsage: {
        "claude-sonnet-4": {
          inputTokens: 100,
          outputTokens: 50,
          thinkingTokens: 10,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 30,
          webSearchRequests: 1,
          costUSD: 0.0123,
          contextWindow: 200000,
          maxOutputTokens: 32000,
          canonicalModel: "claude-sonnet-4",
          provider: "firstParty",
        },
      },
      permission_denials: [],
      uuid: "result-1",
      session_id: "provider-session-1",
    } as unknown as SDKMessage);

    expect(usageEvent).toMatchObject({
      type: "usage_updated",
      usage: {
        totalCostUsd: 0.0123,
        inputTokens: 100,
        outputTokens: 50,
        thinkingTokens: 10,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 30,
        webSearchRequests: 1,
      },
    });
    expect(() => parseAgentEvent(usageEvent)).not.toThrow();
  });

  it("preserves rate-limit utilization when Claude reports it", () => {
    const events = mapClaudeMessage({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 82,
        resetsAt: 1788940800000,
      },
      uuid: "rate-1",
      session_id: "provider-session-1",
    } as unknown as SDKMessage);

    const [event] = events;
    expect(event).toMatchObject({
      type: "rate_limit_updated",
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 82,
    });
    expect(() => parseAgentEvent(event)).not.toThrow();
  });

  it("normalizes max turn failures without losing Claude's original message", () => {
    const events = mapClaudeMessage({
      type: "result",
      subtype: "error",
      duration_ms: 1200,
      duration_api_ms: 900,
      is_error: true,
      num_turns: 20,
      result: "",
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      errors: ["Claude Code returned an error result: Reached maximum number of turns (20)"],
      uuid: "result-1",
      session_id: "provider-session-1",
    } as unknown as SDKMessage);

    const event = events.find((candidate) => candidate.type === "failed");
    expect(event).toMatchObject({
      type: "failed",
      classification: "PROVIDER",
      error: {
        message: "Claude Code returned an error result: Reached maximum number of turns (20)",
        code: "max_turns",
      },
    });
    expect(() => parseAgentEvent(event)).not.toThrow();
  });
});
