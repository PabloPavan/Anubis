import type { ProjectApi } from "../../shared/projects";

declare global {
  interface Window {
    anubis: {
      projects: ProjectApi;
    };
  }
}

export {};
