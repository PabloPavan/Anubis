import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectService } from "../../src/main/application/project-service";
import { openDatabase } from "../../src/main/database/database";
import {
  ProjectConflictError,
  ProjectRepository,
} from "../../src/main/repositories/project-repository";

describe("project persistence", () => {
  let directory: string;
  let database: DatabaseSync;
  let service: ProjectService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "anubis-projects-"));
    database = openDatabase(":memory:");
    service = new ProjectService(new ProjectRepository(database));
  });

  afterEach(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("creates, updates, lists, and archives a project", async () => {
    const created = await service.create({
      name: "Engine",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
    });

    expect(created.enabled).toBe(true);
    expect(service.list()).toEqual([created]);

    const updated = await service.update({
      id: created.id,
      name: "Engine Next",
      path: directory,
      provider: "claude",
      workflow: "superpowers",
      enabled: true,
    });
    expect(updated.name).toBe("Engine Next");

    service.archive(created.id);
    expect(service.list()[0]?.enabled).toBe(false);

    const restored = service.unarchive(created.id);
    expect(restored.enabled).toBe(true);
    expect(restored.path).toBe(created.path);
  });

  it("rejects two projects pointing to the same canonical directory", async () => {
    const draft = {
      name: "Engine",
      path: directory,
      provider: "claude" as const,
      workflow: "superpowers" as const,
    };
    await service.create(draft);
    await expect(service.create({ ...draft, name: "Duplicate" })).rejects.toBeInstanceOf(
      ProjectConflictError,
    );
  });

  it("allows a new active project to reuse an archived project directory", async () => {
    const draft = {
      name: "Engine",
      path: directory,
      provider: "claude" as const,
      workflow: "superpowers" as const,
    };
    const archived = await service.create(draft);
    service.archive(archived.id);

    const replacement = await service.create({ ...draft, name: "Engine Replacement" });

    expect(replacement.enabled).toBe(true);
    expect(replacement.path).toBe(archived.path);
    expect(service.list().map((project) => project.enabled)).toEqual([true, false]);
    expect(() => service.unarchive(archived.id)).toThrow(ProjectConflictError);
  });

  it("reports missing directories without throwing from validation", async () => {
    await expect(service.validatePath(join(directory, "missing"))).resolves.toEqual({
      valid: false,
      message: "Choose an existing directory with read and write access.",
    });
  });

  it("records and applies the initial migration", () => {
    const migrations = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    const versions = migrations.map((migration) => migration.version);
    expect(versions).toEqual(Array.from({ length: 12 }, (_value, index) => index + 1));
    const mode = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(["memory", "wal"]).toContain(mode.journal_mode);
  });
});
