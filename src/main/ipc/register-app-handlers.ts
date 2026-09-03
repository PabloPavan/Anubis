import { ipcMain } from "electron";
import { ProviderUnavailableError } from "../providers/agent-provider";
import { ipcChannels } from "../../shared/ipc";
import { InputValidationError } from "../../shared/projects";
import { AppHealthService } from "../application/app-health-service";
import { BrainstormService } from "../application/brainstorm-service";
import { ClaudeDemoService } from "../application/claude-demo-service";

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
  claudeDemo: ClaudeDemoService,
  brainstorm: BrainstormService,
): () => void {
  ipcMain.handle(ipcChannels.appGetHealth, () => invokeSafely(() => health.getHealth()));
  ipcMain.handle(ipcChannels.appRunClaudeDemo, (_event, projectId: unknown) =>
    invokeSafely(() => claudeDemo.run(projectId)),
  );
  ipcMain.handle(ipcChannels.appListSessionEvents, (_event, sessionId: unknown) =>
    invokeSafely(() => brainstorm.listSessionEvents(sessionId)),
  );
  ipcMain.handle(ipcChannels.appStartBrainstorm, (_event, input: unknown) =>
    invokeSafely(() => brainstorm.start(input)),
  );
  ipcMain.handle(ipcChannels.appListTasks, (_event, projectId: unknown) =>
    invokeSafely(() => brainstorm.listTasks(projectId)),
  );

  return () => {
    ipcMain.removeHandler(ipcChannels.appGetHealth);
    ipcMain.removeHandler(ipcChannels.appRunClaudeDemo);
    ipcMain.removeHandler(ipcChannels.appListSessionEvents);
    ipcMain.removeHandler(ipcChannels.appStartBrainstorm);
    ipcMain.removeHandler(ipcChannels.appListTasks);
  };
}
