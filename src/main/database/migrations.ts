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
  {
    version: 2,
    sql: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        spec_path TEXT,
        spec_sha256 TEXT,
        spec_approved_at TEXT,
        plan_path TEXT,
        plan_sha256 TEXT,
        status TEXT NOT NULL,
        resume_stage TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        is_paused INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0, 1)),
        provider TEXT NOT NULL,
        workflow TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        blocked_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(project_id, task_number)
      ) STRICT;

      CREATE TABLE execution_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        outcome_summary TEXT,
        UNIQUE(task_id, attempt_number)
      ) STRICT;

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('BRAINSTORM', 'EXECUTION')),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        suspended_at TEXT,
        ended_at TEXT
      ) STRICT;

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        sequence INTEGER,
        schema_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        persistence TEXT NOT NULL CHECK (persistence IN ('EPHEMERAL', 'DURABLE')),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      ) STRICT;

      CREATE INDEX idx_tasks_runnable
        ON tasks(project_id, status, is_paused, priority DESC, position, created_at);
      CREATE INDEX idx_tasks_attention
        ON tasks(status, updated_at);
      CREATE INDEX idx_sessions_task_type
        ON sessions(task_id, type, created_at DESC);
      CREATE INDEX idx_events_task_time
        ON events(task_id, occurred_at DESC);
      CREATE INDEX idx_events_session_sequence
        ON events(session_id, sequence);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE task_specs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content_markdown TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        approved_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, version)
      ) STRICT;

      CREATE INDEX idx_task_specs_task_version
        ON task_specs(task_id, version DESC);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE notification_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        desktop_enabled INTEGER NOT NULL DEFAULT 1 CHECK (desktop_enabled IN (0, 1)),
        brainstorm_needs_answer INTEGER NOT NULL DEFAULT 1 CHECK (brainstorm_needs_answer IN (0, 1)),
        brainstorm_ready_for_review INTEGER NOT NULL DEFAULT 1 CHECK (brainstorm_ready_for_review IN (0, 1)),
        brainstorm_failed INTEGER NOT NULL DEFAULT 1 CHECK (brainstorm_failed IN (0, 1)),
        execution_completed INTEGER NOT NULL DEFAULT 1 CHECK (execution_completed IN (0, 1)),
        execution_failed INTEGER NOT NULL DEFAULT 1 CHECK (execution_failed IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO notification_settings(
        id,
        desktop_enabled,
        brainstorm_needs_answer,
        brainstorm_ready_for_review,
        brainstorm_failed,
        execution_completed,
        execution_failed,
        updated_at
      ) VALUES (1, 1, 1, 1, 1, 1, 1, datetime('now'));
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE notification_settings
        ADD COLUMN desktop_sound INTEGER NOT NULL DEFAULT 1 CHECK (desktop_sound IN (0, 1));
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE project_execution_locks (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_project_execution_locks_task
        ON project_execution_locks(task_id);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE tasks
        ADD COLUMN auto_resume_at TEXT;

      ALTER TABLE tasks
        ADD COLUMN last_failure_code TEXT;

      ALTER TABLE notification_settings
        ADD COLUMN auto_resume_after_limit INTEGER NOT NULL DEFAULT 1 CHECK (auto_resume_after_limit IN (0, 1));

      CREATE INDEX idx_tasks_auto_resume
        ON tasks(status, auto_resume_at);
    `,
  },
  {
    version: 8,
    sql: `
      UPDATE projects
      SET canonical_path = canonical_path || '#archived:' || id
      WHERE enabled = 0
        AND canonical_path NOT LIKE '%#archived:%';
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE tasks
        ADD COLUMN model TEXT NOT NULL DEFAULT 'default';

      ALTER TABLE tasks
        ADD COLUMN effort TEXT NOT NULL DEFAULT 'default';
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE project_memory (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        content_markdown TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE task_context_links (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'summary' CHECK (mode IN ('summary')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, source_task_id)
      ) STRICT;

      CREATE INDEX idx_task_context_links_source
        ON task_context_links(source_task_id);
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE notification_settings
        ADD COLUMN controlled_max_turns INTEGER NOT NULL DEFAULT 1 CHECK (controlled_max_turns IN (0, 1));
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
