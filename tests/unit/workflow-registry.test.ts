import { describe, expect, it } from "vitest";
import { retryPromptForWorkflow } from "../../src/main/workflows/workflow-registry";
import type { Task } from "../../src/shared/tasks";

function task(workflow: Task["workflow"]): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    taskNumber: 7,
    title: "Terminal task",
    description: "Keep working in the interactive session.",
    status: "READY_TO_RESUME",
    provider: "claude",
    workflow,
    model: "default",
    effort: "default",
    revision: 1,
    createdAt: "2026-09-21T12:00:00.000Z",
    updatedAt: "2026-09-21T12:00:00.000Z",
  };
}

describe("workflow registry", () => {
  it("uses an interactive resume prompt for terminal workflow", () => {
    const prompt = retryPromptForWorkflow("terminal", task("terminal"));

    expect(prompt).toContain("Continue this Anubis terminal session");
    expect(prompt).toContain("Do not return a formal spec");
    expect(prompt).not.toContain("brainstorm/design workflow");
    expect(prompt).not.toContain("return the spec");
  });
});
