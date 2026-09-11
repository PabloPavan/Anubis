import type { TaskPlan, TaskSpec, TaskSummary } from "../../shared/app";
import type { AgentEventEnvelope } from "../../shared/agent-events";

function planBlock(plan: TaskPlan | null): string[] {
  if (!plan) return ["Implementation plan:", "No stored implementation plan was found. Inspect the repository and proceed carefully from the approved spec."];
  return ["Implementation plan:", plan.contentMarkdown];
}

export function implementationPrompt(task: TaskSummary, spec: TaskSpec, plan: TaskPlan | null): string {
  return [
    "You are implementing an approved Anubis task in a local repository.",
    "Use the Superpowers sub-agent driven implementation workflow/plugin for the execution step.",
    "If Superpowers exposes a sub-agent driven skill/workflow, invoke and follow it before changing files.",
    "Use the approved spec below as the source of truth.",
    "Use the implementation plan below as the intended execution path.",
    "Make focused code changes only for this task.",
    "Follow the repository's existing style and conventions.",
    "Run the smallest relevant verification command when practical.",
    "When finished, summarize changed files, behavior, and verification results.",
    "",
    `Task #${task.taskNumber}: ${task.title}`,
    "",
    "Approved spec:",
    spec.contentMarkdown,
    "",
    ...planBlock(plan),
  ].join("\n");
}

export function resumeImplementationPrompt(
  task: TaskSummary,
  spec: TaskSpec,
  plan: TaskPlan | null,
  previousEvents: AgentEventEnvelope[],
): string {
  const recentEvents = previousEvents
    .slice(-20)
    .map((event) => {
      const payload = event.payload;
      if (payload.type === "completed") return `completed: ${payload.summary ?? ""}`.trim();
      if (payload.type === "failed") return `failed: ${payload.error.message}`;
      if (payload.type === "message_completed") return `assistant: ${payload.text ?? ""}`.trim();
      if (payload.type === "tool_started") return `tool_started: ${payload.tool}${payload.detail ? ` ${payload.detail}` : ""}`;
      if (payload.type === "tool_finished") return `tool_finished: ${payload.tool}${payload.detail ? ` ${payload.detail}` : ""}`;
      if (payload.type === "execution_reviewed") {
        return `user_execution_review: ${payload.decision}${payload.feedback ? ` - ${payload.feedback}` : ""}`;
      }
      if (payload.type === "session_finished") return `session_finished: ${payload.outcome}`;
      return payload.type;
    })
    .filter((line) => line.length > 0)
    .join("\n");

  return [
    "Resume an interrupted Anubis implementation task in this local repository.",
    "Use the Superpowers sub-agent driven implementation workflow/plugin for the execution step.",
    "If Superpowers exposes a sub-agent driven skill/workflow, invoke and follow it before changing files.",
    "Continue from the previous Claude session and do not restart completed work unnecessarily.",
    "Inspect the current repository state before changing files.",
    "Use the approved spec as the source of truth.",
    "Use the implementation plan below as the intended execution path.",
    "Run the smallest relevant verification command when practical.",
    "When finished, summarize changed files, behavior, and verification results.",
    "",
    `Task #${task.taskNumber}: ${task.title}`,
    "",
    "Approved spec:",
    spec.contentMarkdown,
    "",
    ...planBlock(plan),
    "",
    "Recent persisted execution events:",
    recentEvents || "No previous execution events were persisted.",
  ].join("\n");
}
