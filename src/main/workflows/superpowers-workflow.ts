import type { BrainstormDraft, TaskSpec, TaskSummary } from "../../shared/app";

export function superpowersBrainstormPrompt(input: BrainstormDraft): string {
  return [
    "Use the Superpowers workflow/plugin for this brainstorm.",
    "If Superpowers exposes a brainstorm/design skill, invoke and follow it before answering.",
    "This is design-only. Do not modify files. Do not run write commands.",
    "Inspect the repository only when useful and keep tool use read-only.",
    "Clarify the requested work and propose a concise implementation direction.",
    "If you need user input before writing a useful spec, finish with this exact Markdown structure:",
    "### Questions",
    "1. Question text?",
    "- Option A",
    "- Option B",
    "- Option C",
    "Use 2-5 concrete options when possible. Avoid asking questions if the spec can be drafted with reasonable assumptions.",
    "",
    `Task title: ${input.title}`,
    "",
    "Task description:",
    input.description,
    "",
    "If no user input is needed, respond with the proposed spec as Markdown.",
  ].join("\n");
}

export function superpowersWritingPlanPrompt(task: TaskSummary, spec: TaskSpec): string {
  return [
    "Use the Superpowers workflow/plugin for writing an implementation plan.",
    "If Superpowers exposes a writing-plan/planning skill, invoke and follow it before answering.",
    "This is planning-only. Do not modify files. Do not run write commands.",
    "Inspect the repository only when useful and keep tool use read-only.",
    "Produce a practical Markdown implementation plan that can be used by the later execution step.",
    "Include the files/areas likely to change, ordered steps, verification, and risks/open questions.",
    "Do not restate the entire spec unless needed for clarity.",
    "",
    `Task #${task.taskNumber}: ${task.title}`,
    "",
    "Approved spec:",
    spec.contentMarkdown,
  ].join("\n");
}
