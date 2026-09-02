import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        provider TEXT NOT NULL,
        workflow TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_projects_enabled_name
        ON projects(enabled, name COLLATE NOCASE);
    `,
  },
];

export function runMigrations(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedRows = database.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
