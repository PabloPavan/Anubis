import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiProvider } from "../../src/main/providers/gemini/gemini-provider";
import { ProviderUnavailableError } from "../../src/main/providers/agent-provider";

describe("gemini provider", () => {
  it("reports available health when an executable is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anubis-gemini-provider-"));
    const executable = join(directory, "gemini.exe");
    await writeFile(executable, "");
    const provider = new GeminiProvider({ executablePath: executable });

    try {
      expect(provider.id).toBe("gemini");
      expect(provider.displayName).toBe("Gemini");
      expect(provider.capabilities()).toEqual({
        streaming: true,
        cancellation: true,
        resume: true,
        structuredQuestions: false,
        subagentEvents: true,
      });
      const health = await provider.health();
      expect(health.available).toBe(true);
      expect(health.message).toContain(executable);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports available health when an apiKey is provided", async () => {
    const provider = new GeminiProvider({ apiKey: "test-api-key" });
    const health = await provider.health();
    expect(health.available).toBe(true);
    expect(health.message).toContain("API key");
  });

  it("reports unavailable health when executable is missing", async () => {
    const provider = new GeminiProvider({ executablePath: "C:\\missing\\gemini.exe" });
    await expect(provider.health()).resolves.toEqual({
      available: false,
      message: "Gemini executable was not found at C:\\missing\\gemini.exe.",
    });
  });

  it("rejects startSession when unconfigured", async () => {
    const provider = new GeminiProvider({ executablePath: "C:\\missing\\gemini.exe" });
    await expect(
      provider.startSession({
        cwd: "C:\\repo",
        prompt: "Test prompt",
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("rejects sendMessage until streaming input is wired", async () => {
    const provider = new GeminiProvider();
    await expect(
      provider.sendMessage({ provider: "gemini", providerSessionId: "session-1" }, "hello"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
