import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type { ProjectApi } from "../shared/projects";

const projects: ProjectApi = Object.freeze({
  list: () => ipcRenderer.invoke(ipcChannels.projectsList),
  validatePath: (path) => ipcRenderer.invoke(ipcChannels.projectsValidatePath, path),
  selectDirectory: () => ipcRenderer.invoke(ipcChannels.projectsSelectDirectory),
  create: (input) => ipcRenderer.invoke(ipcChannels.projectsCreate, input),
  update: (input) => ipcRenderer.invoke(ipcChannels.projectsUpdate, input),
  archive: (id) => ipcRenderer.invoke(ipcChannels.projectsArchive, id),
});

contextBridge.exposeInMainWorld("anubis", Object.freeze({ projects }));
