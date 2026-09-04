import type { TaskSpec, TaskSummary } from "../../shared/app";

export function implementationPrompt(task: TaskSummary, spec: TaskSpec): string {
  return [
    "You are implementing an approved Anubis task in a local repository.",
    "Use the approved spec below as the source of truth.",
    "Make focused code changes only for this task.",
    "Follow the repository's existing style and conventions.",
    "Run the smallest relevant verification command when practical.",
    "When finished, summarize changed files, behavior, and verification results.",
    "",
    `Task #${task.taskNumber}: ${task.title}`,
    "",
    "Approved spec:",
    spec.contentMarkdown,
  ].join("\n");
}
