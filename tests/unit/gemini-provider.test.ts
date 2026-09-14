import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiProvider, resolveModelName } from "../../src/main/providers/gemini/gemini-provider";
import { ProviderUnavailableError } from "../../src/main/providers/agent-provider";
import type { ProviderSessionRef } from "../../src/main/providers/agent-provider";
import type { AgentEvent } from "../../src/shared/agent-events";

async function collectEvents(provider: GeminiProvider, session: ProviderSessionRef): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of provider.events(session, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

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

  describe("Gemini REST API execution & error handling", () => {
    const originalFetch = globalThis.fetch;
    const testApiKey = "test-secret-gemini-key";

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    describe("Security & Credential Hygiene", () => {
      it("sends API key in x-goog-api-key header and never in URL query string", async () => {
        let calledUrl = "";
        let calledHeaders: Record<string, string> = {};

        globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
          calledUrl = url.toString();
          calledHeaders = (init?.headers ?? {}) as Record<string, string>;
          return new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: "Valid response content" }] } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        });

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Draft plan",
          metadata: {},
        });

        const events = await collectEvents(provider, session);

        expect(calledUrl).not.toContain("?key=");
        expect(calledUrl).not.toContain(testApiKey);
        expect(calledUrl).toBe(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        );

        expect(calledHeaders["x-goog-api-key"]).toBe(testApiKey);

        expect(events.map((e) => e.type)).toEqual([
          "session_started",
          "thinking_status",
          "message_completed",
          "completed",
          "session_finished",
        ]);
      });

      it("does not leak API key in error messages or events upon failure", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response("Invalid credentials provided", {
            status: 401,
            headers: { "Content-Type": "text/plain" },
          }),
        );

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Analyze codebase",
          metadata: {},
        });

        const events = await collectEvents(provider, session);
        const failedEvent = events.find((e) => e.type === "failed");

        expect(failedEvent).toBeDefined();
        if (failedEvent && failedEvent.type === "failed") {
          expect(failedEvent.classification).toBe("AUTH");
          expect(failedEvent.error.message).not.toContain(testApiKey);
          expect(failedEvent.error.message).toContain("401");
        }
      });
    });

    describe("Pre-flight Input Validation", () => {
      it("fails immediately without calling API when prompt is empty or whitespace", async () => {
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock;

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "   \n\t  ",
          metadata: {},
        });

        const events = await collectEvents(provider, session);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(events).toEqual([
          { type: "session_started" },
          {
            type: "failed",
            classification: "PROVIDER",
            error: { message: "Cannot start Gemini session with an empty prompt." },
          },
          { type: "session_finished", outcome: "FAILED" },
        ]);
      });

      it("fails immediately without calling API when model name is unknown/invalid", async () => {
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock;

        const provider = new GeminiProvider({ apiKey: testApiKey, model: "claude-3-5-sonnet" });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Valid prompt",
          metadata: {},
        });

        const events = await collectEvents(provider, session);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(events).toEqual([
          { type: "session_started" },
          {
            type: "failed",
            classification: "PROVIDER",
            error: {
              message:
                "Unknown Gemini model: claude-3-5-sonnet. Use gemini-X.X-{pro|flash|flash-lite} or an alias.",
            },
          },
          { type: "session_finished", outcome: "FAILED" },
        ]);
      });
    });

    describe("Thinking Budget Mapping", () => {
      it.each([
        ["off", 0],
        ["low", 1024],
        ["medium", 8192],
        ["high", 24576],
        ["xhigh", 24576],
        ["max", 24576],
      ] as const)("maps effort %s to thinkingBudget %i in request body", async (effort, expectedBudget) => {
        let capturedBody: any;
        globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
          capturedBody = JSON.parse(init.body as string);
          return new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: "Done" }] } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        });

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Generate plan",
          effort,
          metadata: {},
        });

        await collectEvents(provider, session);

        expect(capturedBody.generationConfig).toEqual({
          thinkingConfig: {
            thinkingBudget: expectedBudget,
          },
        });
      });
    });

    describe("Status Code & HTTP Error Handling", () => {
      it("handles HTTP 401 / 403 as AUTH failure classification", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response("API key expired or invalid permissions", {
            status: 403,
            headers: { "Content-Type": "text/plain" },
          }),
        );

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Valid prompt",
          metadata: {},
        });

        const events = await collectEvents(provider, session);

        expect(events).toContainEqual({
          type: "failed",
          classification: "AUTH",
          error: {
            message: "Gemini API error (403): API key expired or invalid permissions",
          },
        });
        expect(events).toContainEqual({
          type: "session_finished",
          outcome: "FAILED",
        });
      });

      it("handles HTTP 429 and extracts integer Retry-After header", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response("Quota exceeded", {
            status: 429,
            headers: {
              "Content-Type": "text/plain",
              "Retry-After": "30",
            },
          }),
        );

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Valid prompt",
          metadata: {},
        });

        const events = await collectEvents(provider, session);
        const failedEvent = events.find((e) => e.type === "failed");

        expect(failedEvent).toEqual({
          type: "failed",
          classification: "RATE_LIMIT",
          error: {
            message: "Gemini API error (429): Quota exceeded",
            retryAfterSeconds: 30,
          },
        });
      });

      it("handles HTTP 429 and parses HTTP-date Retry-After header", async () => {
        const futureDate = new Date(Date.now() + 45_000).toUTCString();
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response("Rate limit reached", {
            status: 429,
            headers: {
              "Content-Type": "text/plain",
              "Retry-After": futureDate,
            },
          }),
        );

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Valid prompt",
          metadata: {},
        });

        const events = await collectEvents(provider, session);
        const failedEvent = events.find((e) => e.type === "failed");

        expect(failedEvent).toBeDefined();
        if (failedEvent && failedEvent.type === "failed") {
          expect(failedEvent.classification).toBe("RATE_LIMIT");
          expect(failedEvent.error.retryAfterSeconds).toBeGreaterThanOrEqual(40);
          expect(failedEvent.error.retryAfterSeconds).toBeLessThanOrEqual(50);
        }
      });

      it("handles HTTP 500 / 503 as PROVIDER failure classification", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response("Backend unavailable", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          }),
        );

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Valid prompt",
          metadata: {},
        });

        const events = await collectEvents(provider, session);

        expect(events).toContainEqual({
          type: "failed",
          classification: "PROVIDER",
          error: {
            message: "Gemini API error (503): Backend unavailable",
          },
        });
      });
    });

    describe("Response Body Validation & Integrity", () => {
      it("fails when API returns an error field inside JSON body (data.error)", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: {
                code: 400,
                message: "API key not valid. Please pass a valid API key.",
                status: "INVALID_ARGUMENT",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Valid prompt",
          metadata: {},
        });

        const events = await collectEvents(provider, session);

        expect(events).toContainEqual({
          type: "failed",
          classification: "PROVIDER",
          error: {
            message: "Gemini API error: API key not valid. Please pass a valid API key.",
          },
        });
        expect(events).toContainEqual({
          type: "session_finished",
          outcome: "FAILED",
        });
      });

      it("fails when candidates array is empty", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ candidates: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Valid prompt",
          metadata: {},
        });

        const events = await collectEvents(provider, session);

        expect(events).toContainEqual({
          type: "failed",
          classification: "PROVIDER",
          error: {
            message: "Gemini API returned empty response. This may indicate an invalid model or request.",
          },
        });
        expect(events).toContainEqual({
          type: "session_finished",
          outcome: "FAILED",
        });
      });

      it("fails when candidates text content is empty or whitespace-only", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: "   \n\t  " }],
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Valid prompt",
          metadata: {},
        });

        const events = await collectEvents(provider, session);

        expect(events).toContainEqual({
          type: "failed",
          classification: "PROVIDER",
          error: {
            message: "Gemini API returned empty response. This may indicate an invalid model or request.",
          },
        });
      });

      it("handles malformed JSON body gracefully", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response("Not valid JSON {", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        const provider = new GeminiProvider({ apiKey: testApiKey });
        const { session } = await provider.startSession({
          cwd: "/test/cwd",
          prompt: "Valid prompt",
          metadata: {},
        });

        const events = await collectEvents(provider, session);
        const failedEvent = events.find((e) => e.type === "failed");

        expect(failedEvent).toBeDefined();
        if (failedEvent && failedEvent.type === "failed") {
          expect(failedEvent.classification).toBe("PROVIDER");
        }
        expect(events).toContainEqual({
          type: "session_finished",
          outcome: "FAILED",
        });
      });
    });

    describe("CLI Fallback Behavior", () => {
      it("throws ProviderUnavailableError when session runs without API key", async () => {
        const directory = await mkdtemp(join(tmpdir(), "anubis-gemini-cli-"));
        const executable = join(directory, "gemini.exe");
        await writeFile(executable, "");

        try {
          const provider = new GeminiProvider({ executablePath: executable });
          const { session } = await provider.startSession({
            cwd: "/test/cwd",
            prompt: "Valid prompt",
            metadata: {},
          });

          await expect(collectEvents(provider, session)).rejects.toThrow(
            /Gemini CLI session support is not yet implemented/,
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    });
  });
});
