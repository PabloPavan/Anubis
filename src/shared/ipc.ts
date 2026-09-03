export const ipcChannels = {
  appGetHealth: "app:get-health",
  projectsList: "projects:list",
  projectsValidatePath: "projects:validate-path",
  projectsSelectDirectory: "projects:select-directory",
  projectsCreate: "projects:create",
  projectsUpdate: "projects:update",
  projectsArchive: "projects:archive",
} as const;
