import type { BrainstormDraft } from "../../shared/app";

export function debugBrainstormPrompt(input: BrainstormDraft): string {
  return [
    "Use an Anubis debug workflow.",
    "Focus on understanding a concrete failure, reproducing it when practical, identifying the likely cause, and defining a focused fix.",
    "Do not use Superpowers unless the user explicitly asks for it.",
    "Inspect the repository only as needed to make the diagnosis useful.",
    "Return a Markdown debug brief with symptoms, likely cause, proposed fix, and verification.",
    "If there is not enough information to reproduce or reason about the issue, ask only the blocking questions.",
    "",
    `Task title: ${input.title}`,
    "",
    "Task description:",
    input.description,
  ].join("\n");
}
