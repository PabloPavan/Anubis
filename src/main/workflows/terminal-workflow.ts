import type { BrainstormDraft } from "../../shared/app";

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
