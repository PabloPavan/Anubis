import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type {
  AppApi,
  BrainstormDraft,
  BrainstormRevisionInput,
  DesktopNotificationTestKind,
  ExecutionReviewDecisionInput,
  NotificationSettings,
  ProjectMemoryUpdateInput,
  QuestionAnswerInput,
  ReviewDecisionInput,
} from "../shared/app";
import type { ProjectApi, ProjectDraft, ProjectUpdate } from "../shared/projects";

const app: AppApi = Object.freeze({
  getHealth: () => ipcRenderer.invoke(ipcChannels.appGetHealth),
  getNotificationSettings: () => ipcRenderer.invoke(ipcChannels.appGetNotificationSettings),
  updateNotificationSettings: (input: NotificationSettings) =>
    ipcRenderer.invoke(ipcChannels.appUpdateNotificationSettings, input),
  testDesktopNotification: (kind: DesktopNotificationTestKind) =>
    ipcRenderer.invoke(ipcChannels.appTestDesktopNotification, kind),
  listSessionEvents: (sessionId: string) => ipcRenderer.invoke(ipcChannels.appListSessionEvents, sessionId),
  listTaskEvents: (taskId: string) => ipcRenderer.invoke(ipcChannels.appListTaskEvents, taskId),
  createTaskDraft: (input: BrainstormDraft) => ipcRenderer.invoke(ipcChannels.appCreateTaskDraft, input),
  updateTaskDraft: (taskId: string, input: BrainstormDraft) => ipcRenderer.invoke(ipcChannels.appUpdateTaskDraft, { taskId, input }),
  startBrainstorm: (input: BrainstormDraft) => ipcRenderer.invoke(ipcChannels.appStartBrainstorm, input),
  reviseBrainstorm: (input: BrainstormRevisionInput) => ipcRenderer.invoke(ipcChannels.appReviseBrainstorm, input),
  retryBrainstorm: (taskId: string) => ipcRenderer.invoke(ipcChannels.appRetryBrainstorm, taskId),
  answerQuestion: (input: QuestionAnswerInput) => ipcRenderer.invoke(ipcChannels.appAnswerQuestion, input),
  startTaskExecution: (taskId: string) => ipcRenderer.invoke(ipcChannels.appStartTaskExecution, taskId),
  reviewExecution: (input: ExecutionReviewDecisionInput) => ipcRenderer.invoke(ipcChannels.appReviewExecution, input),
  listTasks: (projectId: string, limit?: number | null) =>
    ipcRenderer.invoke(ipcChannels.appListTasks, limit === undefined ? projectId : { projectId, limit }),
  getProjectMemory: (projectId: string) => ipcRenderer.invoke(ipcChannels.appGetProjectMemory, projectId),
  updateProjectMemory: (input: ProjectMemoryUpdateInput) => ipcRenderer.invoke(ipcChannels.appUpdateProjectMemory, input),
  getProjectStats: (projectId: string) => ipcRenderer.invoke(ipcChannels.appGetProjectStats, projectId),
  getLatestSpec: (taskId: string) => ipcRenderer.invoke(ipcChannels.appGetLatestSpec, taskId),
  reviewTask: (input: ReviewDecisionInput) => ipcRenderer.invoke(ipcChannels.appReviewTask, input),
});

const projects: ProjectApi = Object.freeze({
  list: () => ipcRenderer.invoke(ipcChannels.projectsList),
  validatePath: (path: string) => ipcRenderer.invoke(ipcChannels.projectsValidatePath, path),
  selectDirectory: () => ipcRenderer.invoke(ipcChannels.projectsSelectDirectory),
  create: (input: ProjectDraft) => ipcRenderer.invoke(ipcChannels.projectsCreate, input),
  update: (input: ProjectUpdate) => ipcRenderer.invoke(ipcChannels.projectsUpdate, input),
  archive: (id: string) => ipcRenderer.invoke(ipcChannels.projectsArchive, id),
  unarchive: (id: string) => ipcRenderer.invoke(ipcChannels.projectsUnarchive, id),
});

contextBridge.exposeInMainWorld("anubis", Object.freeze({ app, projects }));
