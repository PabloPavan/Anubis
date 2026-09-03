import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider } from "../../src/main/providers/claude/claude-provider";
import { ProviderUnavailableError } from "../../src/main/providers/agent-provider";

describe("claude provider foundation", () => {
  it("reports available health when a Claude executable is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anubis-claude-provider-"));
    const executable = join(directory, "claude.exe");
    await writeFile(executable, "");
    const provider = new ClaudeProvider({ executablePath: executable });

    try {
      expect(provider.id).toBe("claude");
      expect(provider.capabilities()).toEqual({
        streaming: true,
        cancellation: true,
        resume: true,
        structuredQuestions: false,
        subagentEvents: true,
      });
      expect((await provider.health()).available).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports unavailable health when the configured executable is missing", async () => {
    const provider = new ClaudeProvider({ executablePath: "C:\\missing\\claude.exe" });

    await expect(provider.health()).resolves.toEqual({
      available: false,
      message: "Claude executable was not found at C:\\missing\\claude.exe.",
    });
  });

  it("rejects sendMessage until streaming input is wired", async () => {
    const provider = new ClaudeProvider();

    await expect(
      provider.sendMessage({ provider: "claude", providerSessionId: "provider-session-1" }, "hello"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
