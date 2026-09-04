import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { AppHealthService } from "./application/app-health-service";
import { BrainstormService } from "./application/brainstorm-service";
import { DesktopNotificationService } from "./application/desktop-notification-service";
import { NotificationSettingsService } from "./application/notification-settings-service";
import { ExecutionService } from "./application/execution-service";
import { ProjectService } from "./application/project-service";
import { openDatabase } from "./database/database";
import { registerAppHandlers } from "./ipc/register-app-handlers";
import { registerProjectHandlers } from "./ipc/register-project-handlers";
import { ClaudeProvider } from "./providers/claude/claude-provider";
import { ProviderRegistry } from "./providers/provider-registry";
import { AgentJournalRepository } from "./repositories/agent-journal-repository";
import { NotificationSettingsRepository } from "./repositories/notification-settings-repository";
import { ProjectRepository } from "./repositories/project-repository";

let mainWindow: BrowserWindow | null = null;
let removeIpcHandlers: Array<() => void> = [];

if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged ? "com.anubis.app" : process.execPath);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0b0e13",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#10141b",
      symbolColor: "#9da7b5",
      height: 44,
    },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
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
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new ClaudeProvider());
  const projectRepository = new ProjectRepository(database);
  const journalRepository = new AgentJournalRepository(database);
  const notificationSettingsRepository = new NotificationSettingsRepository(database);
  const projectService = new ProjectService(projectRepository);
  const notificationIconPath = process.env.ELECTRON_RENDERER_URL
    ? join(process.cwd(), "src/renderer/public/anubis-notification.png")
    : join(__dirname, "../renderer/anubis-notification.png");
  const notifications = new DesktopNotificationService(notificationSettingsRepository, notificationIconPath);
  removeIpcHandlers = [
    registerAppHandlers(
      new AppHealthService(providerRegistry),
      new NotificationSettingsService(notificationSettingsRepository, notifications),
      new BrainstormService(projectRepository, journalRepository, providerRegistry, notifications),
      new ExecutionService(projectRepository, journalRepository, providerRegistry, notifications),
    ),
    registerProjectHandlers(projectService),
  ];
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  for (const removeHandler of removeIpcHandlers) removeHandler();
  removeIpcHandlers = [];
});
