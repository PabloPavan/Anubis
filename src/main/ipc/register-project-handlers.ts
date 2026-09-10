import { dialog, ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import {
  InputValidationError,
  parsePath,
  parseProjectDraft,
  parseProjectId,
  parseProjectUpdate,
} from "../../shared/projects";
import { InvalidProjectPathError, ProjectService } from "../application/project-service";
import {
  ProjectConflictError,
  ProjectNotFoundError,
} from "../repositories/project-repository";

interface SafeIpcError {
  code: "INVALID_INPUT" | "CONFLICT" | "NOT_FOUND" | "INTERNAL";
  message: string;
}

function safeError(error: unknown): SafeIpcError {
  if (error instanceof InputValidationError || error instanceof InvalidProjectPathError) {
    return { code: "INVALID_INPUT", message: error.message };
  }
  if (error instanceof ProjectConflictError) {
    return { code: "CONFLICT", message: error.message };
  }
  if (error instanceof ProjectNotFoundError) {
    return { code: "NOT_FOUND", message: error.message };
  }
  console.error("Unhandled project IPC error", error);
  return { code: "INTERNAL", message: "An unexpected error occurred." };
}

async function invokeSafely<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(JSON.stringify(safeError(error)));
  }
}

export function registerProjectHandlers(service: ProjectService): () => void {
  ipcMain.handle(ipcChannels.projectsList, () => invokeSafely(() => service.list()));
  ipcMain.handle(ipcChannels.projectsValidatePath, (_event, value: unknown) =>
    invokeSafely(() => service.validatePath(parsePath(value))),
  );
  ipcMain.handle(ipcChannels.projectsSelectDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose a project directory",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(ipcChannels.projectsCreate, (_event, value: unknown) =>
    invokeSafely(() => service.create(parseProjectDraft(value))),
  );
  ipcMain.handle(ipcChannels.projectsUpdate, (_event, value: unknown) =>
    invokeSafely(() => service.update(parseProjectUpdate(value))),
  );
  ipcMain.handle(ipcChannels.projectsArchive, (_event, value: unknown) =>
    invokeSafely(() => service.archive(parseProjectId(value))),
  );
  ipcMain.handle(ipcChannels.projectsUnarchive, (_event, value: unknown) =>
    invokeSafely(() => service.unarchive(parseProjectId(value))),
  );

  return () => {
    for (const channel of Object.values(ipcChannels)) ipcMain.removeHandler(channel);
  };
}
