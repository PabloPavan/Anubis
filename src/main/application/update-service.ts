import { app } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  availableVersion?: string;
  message?: string;
  progressPercent?: number;
}

export class UpdateService {
  private status: UpdateStatus = {
    state: "idle",
    currentVersion: app.getVersion(),
  };

  constructor() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => {
      this.status = { state: "checking", currentVersion: app.getVersion() };
    });
    autoUpdater.on("update-available", (info) => {
      this.status = {
        state: "available",
        currentVersion: app.getVersion(),
        availableVersion: info.version,
      };
    });
    autoUpdater.on("update-not-available", () => {
      this.status = { state: "not_available", currentVersion: app.getVersion() };
    });
    autoUpdater.on("download-progress", (progress) => {
      this.status = {
        ...this.status,
        state: "downloading",
        progressPercent: Math.round(progress.percent),
      };
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.status = {
        state: "downloaded",
        currentVersion: app.getVersion(),
        availableVersion: info.version,
      };
    });
    autoUpdater.on("error", (error) => {
      this.status = {
        state: "error",
        currentVersion: app.getVersion(),
        message: error.message,
      };
    });
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.status = {
        state: "not_available",
        currentVersion: app.getVersion(),
        message: "Updates are only available in packaged builds.",
      };
      return this.status;
    }
    this.status = { state: "checking", currentVersion: app.getVersion() };
    await autoUpdater.checkForUpdates();
    return this.status;
  }

  quitAndInstall(): void {
    if (this.status.state !== "downloaded") return;
    autoUpdater.quitAndInstall();
  }
}
