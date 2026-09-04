import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type {
  AppApi,
  BrainstormDraft,
  BrainstormRevisionInput,
  QuestionAnswerInput,
  ReviewDecisionInput,
} from "../shared/app";
import type { ProjectApi, ProjectDraft, ProjectUpdate } from "../shared/projects";

const app: AppApi = Object.freeze({
  getHealth: () => ipcRenderer.invoke(ipcChannels.appGetHealth),
  listSessionEvents: (sessionId: string) => ipcRenderer.invoke(ipcChannels.appListSessionEvents, sessionId),
  startBrainstorm: (input: BrainstormDraft) => ipcRenderer.invoke(ipcChannels.appStartBrainstorm, input),
  reviseBrainstorm: (input: BrainstormRevisionInput) => ipcRenderer.invoke(ipcChannels.appReviseBrainstorm, input),
  answerQuestion: (input: QuestionAnswerInput) => ipcRenderer.invoke(ipcChannels.appAnswerQuestion, input),
  startTaskExecution: (taskId: string) => ipcRenderer.invoke(ipcChannels.appStartTaskExecution, taskId),
  listTasks: (projectId: string, limit?: number | null) =>
    ipcRenderer.invoke(ipcChannels.appListTasks, limit === undefined ? projectId : { projectId, limit }),
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
});

contextBridge.exposeInMainWorld("anubis", Object.freeze({ app, projects }));
