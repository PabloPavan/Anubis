import { Notification } from "electron";
import { existsSync } from "node:fs";
import type { DesktopNotificationTestKind } from "../../shared/app";
import type { Task } from "../../shared/tasks";
import { NotificationSettingsRepository } from "../repositories/notification-settings-repository";

export interface NotificationSink {
  brainstormNeedsAnswer(projectName: string, task: Task, questionCount: number): void;
  brainstormReadyForReview(projectName: string, task: Task): void;
  brainstormFailed(projectName: string, task: Task, summary: string): void;
  executionCompleted(projectName: string, task: Task, summary: string): void;
  executionFailed(projectName: string, task: Task, summary: string): void;
}

function compact(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function taskLabel(task: Task): string {
  return compact(`#${task.taskNumber} ${task.title}`, `Task #${task.taskNumber}`);
}

export class DesktopNotificationService implements NotificationSink {
  private lastNotification: { signature: string; shownAt: number } | null = null;

  constructor(
    private readonly settings: NotificationSettingsRepository,
    private readonly iconPath?: string,
  ) {}

  test(kind: DesktopNotificationTestKind): void {
    const samples: Record<DesktopNotificationTestKind, { title: string; body: string }> = {
      brainstormNeedsAnswer: {
        title: "Answer needed",
        body: "#12 Improve task flow\nExample Project - 1 pending question.",
      },
      brainstormReadyForReview: {
        title: "Spec ready",
        body: "#12 Improve task flow\nExample Project - Review the generated spec.",
      },
      brainstormFailed: {
        title: "Brainstorm failed",
        body: "#12 Improve task flow\nExample Project - Provider returned an error.",
      },
      executionCompleted: {
        title: "Execution done",
        body: "#12 Improve task flow\nExample Project - Implementation completed.",
      },
      executionFailed: {
        title: "Execution failed",
        body: "#12 Improve task flow\nExample Project - Implementation failed.",
      },
    };
    this.show(samples[kind]);
  }

  brainstormNeedsAnswer(projectName: string, task: Task, questionCount: number): void {
    if (!this.isEnabled("brainstormNeedsAnswer")) return;
    this.show({
      title: "Answer needed",
      body: `${taskLabel(task)}\n${projectName} - ${questionCount} pending question${questionCount === 1 ? "" : "s"}.`,
    });
  }

  brainstormReadyForReview(projectName: string, task: Task): void {
    if (!this.isEnabled("brainstormReadyForReview")) return;
    this.show({
      title: "Spec ready",
      body: `${taskLabel(task)}\n${projectName} - Review the generated spec.`,
    });
  }

  brainstormFailed(projectName: string, task: Task, summary: string): void {
    if (!this.isEnabled("brainstormFailed")) return;
    this.show({
      title: "Brainstorm failed",
      body: `${taskLabel(task)}\n${projectName} - ${compact(summary, "Provider returned an error.")}`,
    });
  }

  executionCompleted(projectName: string, task: Task, summary: string): void {
    if (!this.isEnabled("executionCompleted")) return;
    this.show({
      title: "Execution done",
      body: `${taskLabel(task)}\n${projectName} - ${compact(summary, "Implementation completed.")}`,
    });
  }

  executionFailed(projectName: string, task: Task, summary: string): void {
    if (!this.isEnabled("executionFailed")) return;
    this.show({
      title: "Execution failed",
      body: `${taskLabel(task)}\n${projectName} - ${compact(summary, "Implementation failed.")}`,
    });
  }

  private isEnabled(key: Exclude<keyof ReturnType<NotificationSettingsRepository["get"]>, "desktopEnabled">): boolean {
    const current = this.settings.get();
    return current.desktopEnabled && current[key];
  }

  private show(input: { title: string; body: string }): void {
    if (!Notification.isSupported()) return;
    const signature = `${input.title}\n${input.body}`;
    const now = Date.now();
    if (this.lastNotification?.signature === signature && now - this.lastNotification.shownAt < 1_500) return;
    this.lastNotification = { signature, shownAt: now };

    const current = this.settings.get();
    new Notification({
      title: input.title,
      body: input.body,
      ...(this.iconPath && existsSync(this.iconPath) ? { icon: this.iconPath } : {}),
      silent: !current.desktopSound,
    }).show();
  }
}
