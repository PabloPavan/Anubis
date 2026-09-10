import type { DatabaseSync } from "node:sqlite";
import type { Project, ProjectDraft, ProjectUpdate } from "../../shared/projects";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  canonical_path: string;
  enabled: number;
  provider: Project["provider"];
  workflow: Project["workflow"];
  created_at: string;
  updated_at: string;
}

export class ProjectConflictError extends Error {
  constructor() {
    super("This directory is already registered.");
    this.name = "ProjectConflictError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super("Project not found.");
    this.name = "ProjectNotFoundError";
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    provider: row.provider,
    workflow: row.workflow,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed: projects.canonical_path");
}

function archivedCanonicalPath(canonicalPath: string, id: string): string {
  return canonicalPath.includes("#archived:") ? canonicalPath : `${canonicalPath}#archived:${id}`;
}

export class ProjectRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(): Project[] {
    const rows = this.database
      .prepare("SELECT * FROM projects ORDER BY enabled DESC, name COLLATE NOCASE, created_at")
      .all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  get(id: string): Project {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    if (!row) throw new ProjectNotFoundError();
    return toProject(row);
  }

  create(input: ProjectDraft & { id: string; canonicalPath: string; now: string }): Project {
    try {
      this.database
        .prepare(`
          INSERT INTO projects(
            id, name, path, canonical_path, enabled, provider, workflow, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
        `)
        .run(
          input.id,
          input.name,
          input.path,
          input.canonicalPath,
          input.provider,
          input.workflow,
          input.now,
          input.now,
        );
    } catch (error) {
      if (isUniqueConstraint(error)) throw new ProjectConflictError();
      throw error;
    }
    return this.get(input.id);
  }

  update(input: ProjectUpdate & { canonicalPath: string; now: string }): Project {
    const canonicalPath = input.enabled ? input.canonicalPath : archivedCanonicalPath(input.canonicalPath, input.id);
    try {
      const result = this.database
        .prepare(`
          UPDATE projects
          SET name = ?, path = ?, canonical_path = ?, enabled = ?, provider = ?, workflow = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.name,
          input.path,
          canonicalPath,
          input.enabled ? 1 : 0,
          input.provider,
          input.workflow,
          input.now,
          input.id,
        );
      if (result.changes === 0) throw new ProjectNotFoundError();
    } catch (error) {
      if (isUniqueConstraint(error)) throw new ProjectConflictError();
      throw error;
    }
    return this.get(input.id);
  }

  archive(id: string, now: string): void {
    const result = this.database
      .prepare(`
        UPDATE projects
        SET enabled = 0,
            canonical_path = CASE
              WHEN enabled = 1 THEN canonical_path || '#archived:' || id
              ELSE canonical_path
            END,
            updated_at = ?
        WHERE id = ?
      `)
      .run(now, id);
    if (result.changes === 0) throw new ProjectNotFoundError();
  }
}
