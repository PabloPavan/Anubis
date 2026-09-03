import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "../../src/main/providers/claude/claude-provider";
import { ProviderUnavailableError } from "../../src/main/providers/agent-provider";

describe("claude provider foundation", () => {
  it("reports unavailable health until the SDK adapter is integrated", async () => {
    const provider = new ClaudeProvider();

    expect(provider.id).toBe("claude");
    expect(provider.capabilities()).toEqual({
      streaming: false,
      cancellation: false,
      resume: false,
      structuredQuestions: false,
      subagentEvents: false,
    });
    await expect(provider.health()).resolves.toEqual({
      available: false,
      message: "Claude Agent SDK is not integrated in this build.",
    });
  });

  it("rejects session operations instead of fabricating provider behavior", async () => {
    const provider = new ClaudeProvider();

    await expect(
      provider.startSession({ cwd: "C:\\repo", prompt: "Plan only.", metadata: {} }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(
      provider.resumeSession({
        session: { provider: "claude", providerSessionId: "provider-session-1" },
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
