import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "../../src/main/providers/claude/claude-provider";

const runContract = process.env.ANUBIS_RUN_CLAUDE_CONTRACT === "1" ? describe : describe.skip;

runContract("claude provider contract", () => {
  it("starts a local Claude session and streams normalized events", async () => {
    const provider = new ClaudeProvider(
      process.env.ANUBIS_CLAUDE_EXECUTABLE
        ? { executablePath: process.env.ANUBIS_CLAUDE_EXECUTABLE }
        : {},
    );

    const started = await provider.startSession({
      cwd: process.cwd(),
      prompt: "Reply exactly: ANUBIS_SDK_OK",
      metadata: {},
    });

    expect(started.session.provider).toBe("claude");
    expect(started.session.providerSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const controller = new AbortController();
    const events = [];
    for await (const event of provider.events(started.session, controller.signal)) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "session_started" });
    expect(events).toContainEqual({ type: "completed", summary: "ANUBIS_SDK_OK" });
    expect(events).toContainEqual({ type: "session_finished", outcome: "COMPLETED" });
  }, 30_000);
});
