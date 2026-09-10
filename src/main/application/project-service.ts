import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { normalize, resolve } from "node:path";
import type { PathValidation, Project, ProjectDraft, ProjectUpdate } from "../../shared/projects";
import { ProjectRepository } from "../repositories/project-repository";

export class InvalidProjectPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectPathError";
  }
}

export class ProjectService {
  constructor(private readonly projects: ProjectRepository) {}

  list(): Project[] {
    return this.projects.list();
  }

  async validatePath(path: string): Promise<PathValidation> {
    try {
      const canonicalPath = await this.canonicalize(path);
      return { valid: true, canonicalPath };
    } catch (error) {
      return {
        valid: false,
        message: error instanceof Error ? error.message : "The directory could not be validated.",
      };
    }
  }

  async create(input: ProjectDraft): Promise<Project> {
    const canonicalPath = await this.canonicalize(input.path);
    return this.projects.create({
      ...input,
      id: randomUUID(),
      path: canonicalPath,
      canonicalPath: this.uniquenessKey(canonicalPath),
      now: new Date().toISOString(),
    });
  }

  async update(input: ProjectUpdate): Promise<Project> {
    const canonicalPath = await this.canonicalize(input.path);
    return this.projects.update({
      ...input,
      path: canonicalPath,
      canonicalPath: this.uniquenessKey(canonicalPath),
      now: new Date().toISOString(),
    });
  }

  archive(id: string): void {
    this.projects.archive(id, new Date().toISOString());
  }

  unarchive(id: string): Project {
    const project = this.projects.get(id);
    return this.projects.unarchive({
      id,
      canonicalPath: this.uniquenessKey(project.path),
      now: new Date().toISOString(),
    });
  }

  private async canonicalize(input: string): Promise<string> {
    const absolutePath = resolve(input);
    let info;
    try {
      info = await stat(absolutePath);
      await access(absolutePath, constants.R_OK | constants.W_OK);
    } catch {
      throw new InvalidProjectPathError("Choose an existing directory with read and write access.");
    }
    if (!info.isDirectory()) {
      throw new InvalidProjectPathError("The selected path is not a directory.");
    }
    return normalize(await realpath(absolutePath));
  }

  private uniquenessKey(path: string): string {
    return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
  }
}
