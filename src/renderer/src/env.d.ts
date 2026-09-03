import type { AppApi } from "../../shared/app";
import type { ProjectApi } from "../../shared/projects";

declare global {
  interface Window {
    anubis: {
      app: AppApi;
      projects: ProjectApi;
    };
  }
}

export {};
