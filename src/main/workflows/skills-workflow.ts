import type { BrainstormDraft } from "../../shared/app";

export function skillsBrainstormPrompt(input: BrainstormDraft): string {
  return [
    "Use the Gemini Skills workflow for this brainstorm.",
    "Discover and consult relevant skills in .agents/skills/ or global skills (~/.gemini/config/skills/) before answering.",
    "This is design-only. Do not modify files. Do not run write commands.",
    "Inspect the repository only when useful and keep tool use read-only.",
    "Clarify the requested work and propose a concise implementation direction leveraging available skills.",
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
