import { describe, expect, it } from "vitest";
import {
  agentEffortLabels,
  agentModelLabels,
  parseAgentEffortOption,
  parseAgentModelOption,
  providerEfforts,
  providerModels,
  TaskValidationError,
} from "../../src/shared/tasks";

describe("task model and effort options by provider", () => {
  describe("providerModels", () => {
    it("configures gemini models correctly", () => {
      expect(providerModels.gemini).toContain("default");
      expect(providerModels.gemini).toContain("gemini-3.8-pro");
      expect(providerModels.gemini).toContain("gemini-3.8-flash");
      expect(providerModels.gemini).toContain("gemini-2.5-pro");
      expect(providerModels.gemini).toContain("gemini-2.5-flash");
      expect(providerModels.gemini).toContain("gemini-2.5-flash-lite");
      expect(providerModels.gemini).toContain("gemini-2.0-flash");
      expect(providerModels.gemini).toContain("gemini-1.5-pro");
      expect(providerModels.gemini).toContain("gemini-1.5-flash");

      expect(providerModels.gemini).not.toContain("sonnet");
      expect(providerModels.gemini).not.toContain("opus");
      expect(providerModels.gemini).not.toContain("haiku");
    });

    it("configures claude models correctly", () => {
      expect(providerModels.claude).toEqual(["default", "sonnet", "opus", "haiku"]);

      expect(providerModels.claude).not.toContain("gemini-3.8-pro");
      expect(providerModels.claude).not.toContain("gemini-3.8-flash");
      expect(providerModels.claude).not.toContain("gemini-2.5-pro");
      expect(providerModels.claude).not.toContain("gemini-2.5-flash");
    });
  });

  describe("providerEfforts", () => {
    it("configures gemini efforts correctly", () => {
      expect(providerEfforts.gemini).toEqual(["default", "low", "medium", "high", "off"]);

      expect(providerEfforts.gemini).not.toContain("xhigh");
      expect(providerEfforts.gemini).not.toContain("max");
    });

    it("configures claude efforts correctly", () => {
      expect(providerEfforts.claude).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);

      expect(providerEfforts.claude).not.toContain("off");
    });
  });

  describe("agentModelLabels", () => {
    it("provides human-readable labels for all gemini models", () => {
      for (const model of providerModels.gemini) {
        expect(agentModelLabels[model]).toBeDefined();
        expect(agentModelLabels[model].length).toBeGreaterThan(0);
      }
      expect(agentModelLabels["gemini-3.8-flash"]).toBe("Gemini 3.8 Flash");
      expect(agentModelLabels["gemini-3.8-pro"]).toBe("Gemini 3.8 Pro");
      expect(agentModelLabels["gemini-2.5-pro"]).toBe("Gemini 2.5 Pro");
      expect(agentModelLabels["gemini-2.5-flash"]).toBe("Gemini 2.5 Flash");
    });

    it("provides human-readable labels for all claude models", () => {
      for (const model of providerModels.claude) {
        expect(agentModelLabels[model]).toBeDefined();
        expect(agentModelLabels[model].length).toBeGreaterThan(0);
      }
      expect(agentModelLabels.sonnet).toBe("Sonnet");
      expect(agentModelLabels.opus).toBe("Opus");
      expect(agentModelLabels.haiku).toBe("Haiku");
    });
  });

  describe("agentEffortLabels", () => {
    it("provides human-readable labels for all gemini efforts", () => {
      for (const effort of providerEfforts.gemini) {
        expect(agentEffortLabels[effort]).toBeDefined();
        expect(agentEffortLabels[effort].length).toBeGreaterThan(0);
      }
      expect(agentEffortLabels.off).toBe("Thinking Off");
      expect(agentEffortLabels.low).toBe("Low");
      expect(agentEffortLabels.high).toBe("High");
    });

    it("provides human-readable labels for all claude efforts", () => {
      for (const effort of providerEfforts.claude) {
        expect(agentEffortLabels[effort]).toBeDefined();
        expect(agentEffortLabels[effort].length).toBeGreaterThan(0);
      }
      expect(agentEffortLabels.xhigh).toBe("Extra high");
      expect(agentEffortLabels.max).toBe("Max");
    });
  });

  describe("parsers", () => {
    it("parses valid gemini and claude models", () => {
      expect(parseAgentModelOption("gemini-3.8-flash")).toBe("gemini-3.8-flash");
      expect(parseAgentModelOption("sonnet")).toBe("sonnet");
      expect(parseAgentModelOption("default")).toBe("default");
    });

    it("rejects unknown models", () => {
      expect(() => parseAgentModelOption("gpt-4o")).toThrow(TaskValidationError);
      expect(() => parseAgentModelOption(123)).toThrow(TaskValidationError);
    });

    it("parses valid gemini and claude efforts", () => {
      expect(parseAgentEffortOption("off")).toBe("off");
      expect(parseAgentEffortOption("high")).toBe("high");
      expect(parseAgentEffortOption("max")).toBe("max");
    });

    it("rejects unknown efforts", () => {
      expect(() => parseAgentEffortOption("super-high")).toThrow(TaskValidationError);
      expect(() => parseAgentEffortOption(null)).toThrow(TaskValidationError);
    });
  });
});
