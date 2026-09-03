import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { AppHealthService } from "../application/app-health-service";

export function registerAppHandlers(service: AppHealthService): () => void {
  ipcMain.handle(ipcChannels.appGetHealth, () => service.getHealth());

  return () => {
    ipcMain.removeHandler(ipcChannels.appGetHealth);
  };
}
