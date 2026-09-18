import type { BrainstormDraft } from "../../shared/app";
import type { WorkflowId } from "../../shared/projects";
import type { Task } from "../../shared/tasks";
import { antigravityBrainstormPrompt } from "./antigravity-workflow";
import { debugBrainstormPrompt } from "./debug-workflow";
import { quickBrainstormPrompt } from "./quick-workflow";
import { skillsBrainstormPrompt } from "./skills-workflow";
import { superpowersBrainstormPrompt } from "./superpowers-workflow";
import { terminalBrainstormPrompt } from "./terminal-workflow";

export const workflowDisplayNames: Record<WorkflowId, string> = {
  superpowers: "Superpowers",
  quick: "Quick",
  terminal: "Terminal",
  debug: "Debug",
  antigravity: "Antigravity",
  skills: "Skills",
};

export function brainstormPromptForWorkflow(workflow: WorkflowId, input: BrainstormDraft): string {
  switch (workflow) {
    case "quick":
      return quickBrainstormPrompt(input);
    case "terminal":
      return terminalBrainstormPrompt(input);
    case "debug":
      return debugBrainstormPrompt(input);
    case "antigravity":
      return antigravityBrainstormPrompt(input);
    case "skills":
      return skillsBrainstormPrompt(input);
    case "superpowers":
    default:
      return superpowersBrainstormPrompt(input);
  }
}

export function revisionPromptForWorkflow(workflow: WorkflowId, task: Task, feedback: string): string {
  const workflowName = workflowDisplayNames[workflow] ?? "Superpowers";
  return [
    `Continue the ${workflowName} brainstorm/design workflow for this Anubis task.`,
    "Treat the user's feedback below as the next answer/revision request.",
    "Do not modify repository files. Keep the spec inside this response as Markdown.",
    "Return the revised spec as the final answer.",
    "",
    `Task #${task.taskNumber}: ${task.title}`,
    "",
    "User feedback / answer:",
    feedback,
  ].join("\n");
}

export function retryPromptForWorkflow(workflow: WorkflowId, task: Task): string {
  const workflowName = workflowDisplayNames[workflow] ?? "Superpowers";
  return [
    `Continue the ${workflowName} brainstorm/design workflow for this Anubis task.`,
    "The previous Anubis capture failed while recording provider events, so continue from the existing agent session.",
    "Do not modify repository files. Keep the spec inside this response as Markdown.",
    "If you had already asked questions, repeat the pending questions clearly. If the design is ready, return the spec.",
    "",
    `Task #${task.taskNumber}: ${task.title}`,
    "",
    "Original task description:",
    task.description,
  ].join("\n");
}
