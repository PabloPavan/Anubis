import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { ProjectService } from "./application/project-service";
import { openDatabase } from "./database/database";
import { registerProjectHandlers } from "./ipc/register-project-handlers";
import { ProjectRepository } from "./repositories/project-repository";

let mainWindow: BrowserWindow | null = null;
let removeIpcHandlers: (() => void) | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0b0e13",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0b0e13",
      symbolColor: "#9da7b5",
      height: 44,
    },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (current && url !== current) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  const database = openDatabase(join(app.getPath("userData"), "anubis.db"));
  const service = new ProjectService(new ProjectRepository(database));
  removeIpcHandlers = registerProjectHandlers(service);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  removeIpcHandlers?.();
});
