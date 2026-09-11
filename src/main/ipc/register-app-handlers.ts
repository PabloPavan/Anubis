import { ipcMain } from "electron";
import { ProviderUnavailableError } from "../providers/agent-provider";
import { ipcChannels } from "../../shared/ipc";
import { InputValidationError } from "../../shared/projects";
import { AppHealthService } from "../application/app-health-service";
import { BrainstormService } from "../application/brainstorm-service";
import { ExecutionService } from "../application/execution-service";
import { NotificationSettingsService } from "../application/notification-settings-service";
import { UpdateService } from "../application/update-service";

interface SafeIpcError {
  code: "INVALID_INPUT" | "PROVIDER_UNAVAILABLE" | "INTERNAL";
  message: string;
}

function safeError(error: unknown): SafeIpcError {
  if (error instanceof InputValidationError) {
    return { code: "INVALID_INPUT", message: error.message };
  }
  if (error instanceof ProviderUnavailableError) {
    return { code: "PROVIDER_UNAVAILABLE", message: error.message };
  }
  console.error("Unhandled app IPC error", error);
  return { code: "INTERNAL", message: "An unexpected error occurred." };
}

async function invokeSafely<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(JSON.stringify(safeError(error)));
  }
}

export function registerAppHandlers(
  health: AppHealthService,
  notificationSettings: NotificationSettingsService,
  updates: UpdateService,
  brainstorm: BrainstormService,
  execution: ExecutionService,
): () => void {
  ipcMain.handle(ipcChannels.appGetHealth, () => invokeSafely(() => health.getHealth()));
  ipcMain.handle(ipcChannels.appGetUpdateStatus, () => invokeSafely(() => updates.getStatus()));
  ipcMain.handle(ipcChannels.appCheckForUpdates, () => invokeSafely(() => updates.check()));
  ipcMain.handle(ipcChannels.appQuitAndInstallUpdate, () => invokeSafely(() => updates.quitAndInstall()));
  ipcMain.handle(ipcChannels.appGetNotificationSettings, () => invokeSafely(() => notificationSettings.get()));
  ipcMain.handle(ipcChannels.appUpdateNotificationSettings, (_event, input: unknown) =>
    invokeSafely(() => notificationSettings.update(input)),
  );
  ipcMain.handle(ipcChannels.appTestDesktopNotification, (_event, input: unknown) =>
    invokeSafely(() => notificationSettings.testDesktopNotification(input)),
  );
  ipcMain.handle(ipcChannels.appListSessionEvents, (_event, sessionId: unknown) =>
    invokeSafely(() => brainstorm.listSessionEvents(sessionId)),
  );
  ipcMain.handle(ipcChannels.appListTaskEvents, (_event, taskId: unknown) =>
    invokeSafely(() => brainstorm.listTaskEvents(taskId)),
  );
  ipcMain.handle(ipcChannels.appCreateTaskDraft, (_event, input: unknown) =>
    invokeSafely(() => brainstorm.createDraft(input)),
  );
  ipcMain.handle(ipcChannels.appUpdateTaskDraft, (_event, input: unknown) =>
    invokeSafely(() => brainstorm.updateDraft(input)),
  );
  ipcMain.handle(ipcChannels.appStartBrainstorm, (_event, input: unknown) =>
    invokeSafely(() => brainstorm.start(input)),
  );
  ipcMain.handle(ipcChannels.appReviseBrainstorm, (_event, input: unknown) =>
    invokeSafely(() => brainstorm.revise(input)),
  );
  ipcMain.handle(ipcChannels.appRetryBrainstorm, (_event, taskId: unknown) =>
    invokeSafely(() => brainstorm.retry(taskId)),
  );
  ipcMain.handle(ipcChannels.appAnswerQuestion, (_event, input: unknown) =>
    invokeSafely(() => brainstorm.answerQuestion(input)),
  );
  ipcMain.handle(ipcChannels.appStartTaskExecution, (_event, taskId: unknown) =>
    invokeSafely(() => execution.start(taskId)),
  );
  ipcMain.handle(ipcChannels.appReviewExecution, (_event, input: unknown) =>
    invokeSafely(() => execution.reviewExecution(input)),
  );
  ipcMain.handle(ipcChannels.appListTasks, (_event, projectId: unknown) =>
    invokeSafely(() => brainstorm.listTasks(projectId)),
  );
  ipcMain.handle(ipcChannels.appGetProjectMemory, (_event, projectId: unknown) =>
    invokeSafely(() => brainstorm.getProjectMemory(projectId)),
  );
  ipcMain.handle(ipcChannels.appUpdateProjectMemory, (_event, input: unknown) =>
    invokeSafely(() => brainstorm.updateProjectMemory(input)),
  );
  ipcMain.handle(ipcChannels.appGetProjectStats, (_event, projectId: unknown) =>
    invokeSafely(() => brainstorm.getProjectStats(projectId)),
  );
  ipcMain.handle(ipcChannels.appGetLatestSpec, (_event, taskId: unknown) =>
    invokeSafely(() => brainstorm.getLatestSpec(taskId)),
  );
  ipcMain.handle(ipcChannels.appGetLatestPlan, (_event, taskId: unknown) =>
    invokeSafely(() => brainstorm.getLatestPlan(taskId)),
  );
  ipcMain.handle(ipcChannels.appReviewTask, (_event, input: unknown) =>
    invokeSafely(() => brainstorm.reviewTask(input)),
  );

  return () => {
    ipcMain.removeHandler(ipcChannels.appGetHealth);
    ipcMain.removeHandler(ipcChannels.appGetUpdateStatus);
    ipcMain.removeHandler(ipcChannels.appCheckForUpdates);
    ipcMain.removeHandler(ipcChannels.appQuitAndInstallUpdate);
    ipcMain.removeHandler(ipcChannels.appGetNotificationSettings);
    ipcMain.removeHandler(ipcChannels.appUpdateNotificationSettings);
    ipcMain.removeHandler(ipcChannels.appTestDesktopNotification);
    ipcMain.removeHandler(ipcChannels.appListSessionEvents);
    ipcMain.removeHandler(ipcChannels.appListTaskEvents);
    ipcMain.removeHandler(ipcChannels.appCreateTaskDraft);
    ipcMain.removeHandler(ipcChannels.appUpdateTaskDraft);
    ipcMain.removeHandler(ipcChannels.appStartBrainstorm);
    ipcMain.removeHandler(ipcChannels.appReviseBrainstorm);
    ipcMain.removeHandler(ipcChannels.appRetryBrainstorm);
    ipcMain.removeHandler(ipcChannels.appAnswerQuestion);
    ipcMain.removeHandler(ipcChannels.appStartTaskExecution);
    ipcMain.removeHandler(ipcChannels.appReviewExecution);
    ipcMain.removeHandler(ipcChannels.appListTasks);
    ipcMain.removeHandler(ipcChannels.appGetProjectMemory);
    ipcMain.removeHandler(ipcChannels.appUpdateProjectMemory);
    ipcMain.removeHandler(ipcChannels.appGetProjectStats);
    ipcMain.removeHandler(ipcChannels.appGetLatestSpec);
    ipcMain.removeHandler(ipcChannels.appGetLatestPlan);
    ipcMain.removeHandler(ipcChannels.appReviewTask);
  };
}
