import { describe, expect, it } from "vitest";
import {
  InputValidationError,
  parsePath,
  parseProjectDraft,
  parseProjectId,
  parseProjectUpdate,
} from "../../src/shared/projects";

describe("project input validation", () => {
  it("normalizes a valid project draft", () => {
    expect(
      parseProjectDraft({
        name: "  Trading Engine  ",
        path: "  C:\\Projects\\engine  ",
        provider: "claude",
        workflow: "superpowers",
      }),
    ).toEqual({
      name: "Trading Engine",
      path: "C:\\Projects\\engine",
      provider: "claude",
      workflow: "superpowers",
    });
  });

  it("normalizes a valid project draft with gemini provider and antigravity workflow", () => {
    expect(
      parseProjectDraft({
        name: "  Gemini App  ",
        path: "  C:\\Projects\\gemini-app  ",
        provider: "gemini",
        workflow: "antigravity",
      }),
    ).toEqual({
      name: "Gemini App",
      path: "C:\\Projects\\gemini-app",
      provider: "gemini",
      workflow: "antigravity",
    });
  });

  it("normalizes a valid project draft with gemini provider and skills workflow", () => {
    expect(
      parseProjectDraft({
        name: "Gemini Skills App",
        path: "C:\\Projects\\skills-app",
        provider: "gemini",
        workflow: "skills",
      }),
    ).toEqual({
      name: "Gemini Skills App",
      path: "C:\\Projects\\skills-app",
      provider: "gemini",
      workflow: "skills",
    });
  });

  it.each([
    ["empty name", { name: "", path: "C:\\repo", provider: "claude", workflow: "superpowers" }],
    ["unknown provider", { name: "Repo", path: "C:\\repo", provider: "codex", workflow: "superpowers" }],
    ["unknown workflow", { name: "Repo", path: "C:\\repo", provider: "claude", workflow: "custom" }],
    ["incompatible workflow for claude", { name: "Repo", path: "C:\\repo", provider: "claude", workflow: "antigravity" }],
    ["non-object", "repo"],
  ])("rejects %s", (_name, input) => {
    expect(() => parseProjectDraft(input)).toThrow(InputValidationError);
  });

  it("requires a version 4 UUID", () => {
    expect(parseProjectId("31094c36-d44f-4e65-b1e6-7a8c9b28deda")).toBe(
      "31094c36-d44f-4e65-b1e6-7a8c9b28deda",
    );
    expect(() => parseProjectId("../project")).toThrow(InputValidationError);
  });

  it("requires explicit enabled state on updates", () => {
    const update = {
      id: "31094c36-d44f-4e65-b1e6-7a8c9b28deda",
      name: "Repo",
      path: "C:\\repo",
      provider: "claude",
      workflow: "superpowers",
    };
    expect(() => parseProjectUpdate(update)).toThrow(InputValidationError);
    expect(parseProjectUpdate({ ...update, enabled: false }).enabled).toBe(false);
  });

  it("rejects blank and null-containing paths", () => {
    expect(() => parsePath("  ")).toThrow(InputValidationError);
    expect(() => parsePath("C:\\repo\0hidden")).toThrow(InputValidationError);
  });
});
