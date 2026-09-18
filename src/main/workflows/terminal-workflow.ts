import type { BrainstormDraft } from "../../shared/app";
import type { Task } from "../../shared/tasks";

export function terminalBrainstormPrompt(input: BrainstormDraft): string {
  return [
    "Use an Anubis terminal-style workflow.",
    "This task should feel close to using the agent directly from a terminal.",
    "Do not use Superpowers unless the user explicitly asks for it.",
    "Avoid heavy upfront specification. Convert the request into a concise execution brief.",
    "Inspect the repository only when useful.",
    "If the request is actionable, return a short Markdown brief with goal, constraints, and verification.",
    "If a missing detail blocks execution, ask the smallest possible set of questions.",
    "",
    `Task title: ${input.title}`,
    "",
    "Task description:",
    input.description,
  ].join("\n");
}

export function terminalRetryPrompt(task: Task): string {
  return [
    "Continue this Anubis terminal session from the existing conversation.",
    "This workflow is interactive and should feel close to using the agent directly from a terminal.",
    "Do not switch into a brainstorm/design/spec workflow unless the user explicitly asks for it.",
    "Do not return a formal spec just because the session resumed.",
    "If there was an interrupted action, briefly state what you were doing and continue from there.",
    "If the next step needs user input, ask directly and keep it concise.",
    "",
    `Task #${task.taskNumber}: ${task.title}`,
    "",
    "Original task description:",
    task.description,
  ].join("\n");
}
