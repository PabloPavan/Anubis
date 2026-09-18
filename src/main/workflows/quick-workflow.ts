import type { BrainstormDraft } from "../../shared/app";

export function quickBrainstormPrompt(input: BrainstormDraft): string {
  return [
    "Use a lightweight Anubis quick-task workflow.",
    "Do not use Superpowers unless the user explicitly asks for it.",
    "This is for practical local work that may be less formally specified.",
    "Inspect the repository only as needed.",
    "If the request is immediately actionable, return a concise executable brief in Markdown.",
    "If a key decision is missing, ask only the minimum necessary questions.",
    "",
    `Task title: ${input.title}`,
    "",
    "Task description:",
    input.description,
  ].join("\n");
}
