import { join } from "node:path";
import { app, BrowserWindow, dialog, Menu, Tray } from "electron";
import { AppHealthService } from "./application/app-health-service";
import { BrainstormService } from "./application/brainstorm-service";
import { DesktopNotificationService } from "./application/desktop-notification-service";
import { NotificationSettingsService } from "./application/notification-settings-service";
import { ExecutionService } from "./application/execution-service";
import { ProjectService } from "./application/project-service";
import { TaskSchedulerService } from "./application/task-scheduler-service";
import { UpdateService } from "./application/update-service";
import { openDatabase } from "./database/database";
import { registerAppHandlers } from "./ipc/register-app-handlers";
import { registerProjectHandlers } from "./ipc/register-project-handlers";
import { ClaudeProvider } from "./providers/claude/claude-provider";
import { GeminiProvider } from "./providers/gemini/gemini-provider";
import { ProviderRegistry } from "./providers/provider-registry";
import { AgentJournalRepository } from "./repositories/agent-journal-repository";
import { NotificationSettingsRepository } from "./repositories/notification-settings-repository";
import { ProjectRepository } from "./repositories/project-repository";

let mainWindow: BrowserWindow | null = null;
let removeIpcHandlers: Array<() => void> = [];
let taskScheduler: TaskSchedulerService | null = null;
let appJournalRepository: AgentJournalRepository | null = null;
let tray: Tray | null = null;
let appIconPath: string | null = null;
let isQuitting = false;

if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged ? "com.anubis.app" : process.execPath);
}

function showMainWindow(): void {
  if (!mainWindow) {
    if (appJournalRepository && appIconPath) createWindow(appJournalRepository, appIconPath);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(iconPath: string): void {
  if (tray) return;
  tray = new Tray(iconPath);
  tray.setToolTip("Anubis");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Anubis", click: showMainWindow },
    { type: "separator" },
    {
      label: "Quit Anubis",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on("click", showMainWindow);
}

function createWindow(journalRepository: AgentJournalRepository, iconPath: string): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0b0e13",
    icon: iconPath,
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
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    if (tray) {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }
    const runningTasks = journalRepository.countRunningTasks();
    if (runningTasks === 0) return;

    event.preventDefault();
    const taskLabel = runningTasks === 1 ? "1 task is still running" : `${runningTasks} tasks are still running`;
    void dialog
      .showMessageBox(mainWindow!, {
        type: "warning",
        title: "Tasks still running",
        message: taskLabel,
        detail: "Closing Anubis stops the local Claude process. You can keep the app minimized or stop now and resume the task later.",
        buttons: ["Keep running minimized", "Stop and resume later", "Close anyway", "Cancel"],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
      })
      .then(({ response }) => {
        if (!mainWindow) return;
        if (response === 0) {
          mainWindow.minimize();
          return;
        }
        if (response === 1) {
          journalRepository.markInterruptedRunningTasks();
          isQuitting = true;
          app.quit();
          return;
        }
        if (response === 2) {
          isQuitting = true;
          app.quit();
        }
      });
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
  providerRegistry.register(new GeminiProvider());
  const projectRepository = new ProjectRepository(database);
  const journalRepository = new AgentJournalRepository(database);
  appJournalRepository = journalRepository;
  const notificationSettingsRepository = new NotificationSettingsRepository(database);
  const projectService = new ProjectService(projectRepository);
  const notificationIconPath = process.env.ELECTRON_RENDERER_URL
    ? join(process.cwd(), "src/renderer/public/anubis-notification.png")
    : app.isPackaged
      ? join(process.resourcesPath, "anubis-notification.png")
      : join(__dirname, "../renderer/anubis-notification.png");
  appIconPath = notificationIconPath;
  const notifications = new DesktopNotificationService(notificationSettingsRepository, notificationIconPath);
  const updates = new UpdateService();
  createTray(notificationIconPath);
  journalRepository.releaseAllProjectExecutionLocks();
  journalRepository.markInterruptedRunningTasks();
  const brainstormService = new BrainstormService(
    projectRepository,
    journalRepository,
    providerRegistry,
    notifications,
    notificationSettingsRepository,
  );
  const executionService = new ExecutionService(
    projectRepository,
    journalRepository,
    providerRegistry,
    notifications,
    notificationSettingsRepository,
  );
  taskScheduler = new TaskSchedulerService(journalRepository, executionService, brainstormService, notificationSettingsRepository);
  taskScheduler.start();
  removeIpcHandlers = [
    registerAppHandlers(
      new AppHealthService(providerRegistry),
      new NotificationSettingsService(notificationSettingsRepository, notifications),
      updates,
      brainstormService,
      executionService,
    ),
    registerProjectHandlers(projectService),
  ];
  createWindow(journalRepository, notificationIconPath);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && appJournalRepository && appIconPath) {
      createWindow(appJournalRepository, appIconPath);
    }
  });
});

app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});

app.on("will-quit", () => {
  isQuitting = true;
  tray?.destroy();
  tray = null;
  taskScheduler?.stop();
  taskScheduler = null;
  appJournalRepository = null;
  appIconPath = null;
  for (const removeHandler of removeIpcHandlers) removeHandler();
  removeIpcHandlers = [];
});
