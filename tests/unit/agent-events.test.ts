import { describe, expect, it } from "vitest";
import {
  AgentEventValidationError,
  parseAgentEvent,
  parseAgentEventEnvelope,
} from "../../src/shared/agent-events";

describe("agent event validation", () => {
  it("accepts and normalizes a valid provider-neutral event", () => {
    expect(
      parseAgentEvent({
        type: "stage_changed",
        stage: "EXECUTING",
      }),
    ).toEqual({
      type: "stage_changed",
      stage: "EXECUTING",
    });
  });

  it("accepts user messages with attachment metadata", () => {
    expect(
      parseAgentEvent({
        type: "user_message",
        kind: "initial_prompt",
        text: "Task title: Preserve the prompt",
        attachments: [{ name: "screen.png", mediaType: "image/png", sizeBytes: 1024 }],
      }),
    ).toEqual({
      type: "user_message",
      kind: "initial_prompt",
      text: "Task title: Preserve the prompt",
      attachments: [{ name: "screen.png", mediaType: "image/png", sizeBytes: 1024 }],
    });
  });

  it("accepts long completion summaries from provider results", () => {
    const summary = `# Final report\n\n${"Implemented detail.\n".repeat(300)}`;

    expect(
      parseAgentEvent({
        type: "completed",
        summary,
      }),
    ).toEqual({
      type: "completed",
      summary: summary.trim(),
    });
  });

  it("rejects unsupported event types", () => {
    expect(() => parseAgentEvent({ type: "claude_raw_chunk", payload: {} })).toThrow(
      AgentEventValidationError,
    );
  });

  it("rejects invalid enum values inside known events", () => {
    expect(() => parseAgentEvent({ type: "stage_changed", stage: "DEPLOYING" })).toThrow(
      AgentEventValidationError,
    );
  });

  it("rejects blank required text", () => {
    expect(() =>
      parseAgentEvent({
        type: "message_delta",
        messageId: "message-1",
        text: " ",
      }),
    ).toThrow(AgentEventValidationError);
  });

  it("bounds nested plan payloads", () => {
    expect(() =>
      parseAgentEvent({
        type: "plan_updated",
        revision: 1,
        items: [
          {
            id: "item-1",
            title: "Implement adapter",
            status: "done",
          },
        ],
      }),
    ).toThrow(AgentEventValidationError);
  });

  it("accepts a valid event envelope", () => {
    expect(
      parseAgentEventEnvelope({
        eventId: "event-1",
        schemaVersion: 1,
        occurredAt: "2026-09-03T13:46:00.000Z",
        projectId: "project-1",
        taskId: "task-1",
        sessionId: "session-1",
        sequence: 3,
        persistence: "DURABLE",
        payload: { type: "session_started" },
      }),
    ).toEqual({
      eventId: "event-1",
      schemaVersion: 1,
      occurredAt: "2026-09-03T13:46:00.000Z",
      projectId: "project-1",
      taskId: "task-1",
      sessionId: "session-1",
      sequence: 3,
      persistence: "DURABLE",
      payload: { type: "session_started" },
    });
  });

  it("rejects unsupported envelope versions", () => {
    expect(() =>
      parseAgentEventEnvelope({
        eventId: "event-1",
        schemaVersion: 2,
        occurredAt: "2026-09-03T13:46:00.000Z",
        projectId: "project-1",
        taskId: "task-1",
        sessionId: "session-1",
        sequence: 3,
        persistence: "DURABLE",
        payload: { type: "session_started" },
      }),
    ).toThrow(AgentEventValidationError);
  });

  it("rejects non-canonical timestamps in envelopes", () => {
    expect(() =>
      parseAgentEventEnvelope({
        eventId: "event-1",
        schemaVersion: 1,
        occurredAt: "2026-09-03 13:46:00",
        projectId: "project-1",
        taskId: "task-1",
        sessionId: "session-1",
        sequence: 3,
        persistence: "DURABLE",
        payload: { type: "session_started" },
      }),
    ).toThrow(AgentEventValidationError);
  });
});
