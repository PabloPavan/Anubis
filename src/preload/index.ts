import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type { AppApi, BrainstormDraft } from "../shared/app";
import type { ProjectApi, ProjectDraft, ProjectUpdate } from "../shared/projects";

const app: AppApi = Object.freeze({
  getHealth: () => ipcRenderer.invoke(ipcChannels.appGetHealth),
  runClaudeDemo: (projectId: string) => ipcRenderer.invoke(ipcChannels.appRunClaudeDemo, projectId),
  listSessionEvents: (sessionId: string) => ipcRenderer.invoke(ipcChannels.appListSessionEvents, sessionId),
  startBrainstorm: (input: BrainstormDraft) => ipcRenderer.invoke(ipcChannels.appStartBrainstorm, input),
  listTasks: (projectId: string) => ipcRenderer.invoke(ipcChannels.appListTasks, projectId),
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
