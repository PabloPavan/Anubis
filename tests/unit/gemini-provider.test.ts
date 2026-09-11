import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiProvider, resolveModelName } from "../../src/main/providers/gemini/gemini-provider";
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

  describe("resolveModelName", () => {
    it("resolves explicit gemini models directly", () => {
      expect(resolveModelName("gemini-3.8-pro")).toBe("gemini-3.8-pro");
      expect(resolveModelName("gemini-3.8-flash")).toBe("gemini-3.8-flash");
      expect(resolveModelName("gemini-2.5-pro")).toBe("gemini-2.5-pro");
      expect(resolveModelName("gemini-2.5-flash")).toBe("gemini-2.5-flash");
      expect(resolveModelName("gemini-2.5-flash-lite")).toBe("gemini-2.5-flash-lite");
      expect(resolveModelName("gemini-2.0-flash")).toBe("gemini-2.0-flash");
    });

    it("resolves model aliases to their canonical model names", () => {
      expect(resolveModelName("pro")).toBe("gemini-2.5-pro");
      expect(resolveModelName("flash")).toBe("gemini-2.5-flash");
      expect(resolveModelName("flash-lite")).toBe("gemini-2.5-flash-lite");
    });

    it("falls back based on effort when model is default or unspecified", () => {
      expect(resolveModelName("default", "high")).toBe("gemini-2.5-pro");
      expect(resolveModelName(undefined, "high")).toBe("gemini-2.5-pro");
      expect(resolveModelName("default", "low")).toBe("gemini-2.5-flash");
      expect(resolveModelName("default", "medium")).toBe("gemini-2.5-flash");
      expect(resolveModelName("default", "off")).toBe("gemini-2.5-flash");
      expect(resolveModelName("default", "default")).toBe("gemini-2.5-flash");
    });
  });
});
