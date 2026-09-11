import { BrainstormService } from "./brainstorm-service";
import { ExecutionService } from "./execution-service";
import { AgentJournalRepository } from "../repositories/agent-journal-repository";
import { NotificationSettingsRepository } from "../repositories/notification-settings-repository";

export class TaskSchedulerService {
  private readonly activeTaskIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private isPolling = false;

  constructor(
    private readonly journal: AgentJournalRepository,
    private readonly execution: ExecutionService,
    private readonly brainstorm: BrainstormService,
    private readonly settings: NotificationSettingsRepository,
    private readonly intervalMs = 3000,
    private readonly maxConcurrentTasks = 4,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const availableSlots = Math.max(0, this.maxConcurrentTasks - this.activeTaskIds.size);
      if (availableSlots === 0) return;
      const tasks = this.journal.listRunnableQueuedTasks(availableSlots, this.settings.get().autoResumeAfterLimit);
      for (const task of tasks) {
        if (this.activeTaskIds.has(task.id)) continue;
        this.activeTaskIds.add(task.id);
        void this.runTask(task.id);
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async runTask(taskId: string): Promise<void> {
    try {
      const task = this.journal.getTask(taskId);
      const latestSession = this.journal.getLatestSessionForTask(taskId);
      if (task.status === "READY_TO_RESUME" && latestSession?.type === "BRAINSTORM") {
        await this.brainstorm.retry(taskId);
      } else {
        await this.execution.start(taskId);
      }
    } catch (error) {
      console.error("Task scheduler failed to execute queued task", { taskId, error });
    } finally {
      this.activeTaskIds.delete(taskId);
    }
  }
}
