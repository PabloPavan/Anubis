# Phase 1 Implementation Plan — Secure Shell and Projects

## Goal

Deliver the first vertical slice of the approved design: a secure Electron application that stores local projects in SQLite and lets the user validate, create, list, edit, and archive them.

## Scope

1. Establish Electron main, sandboxed preload, React renderer, and TypeScript build boundaries.
2. Add versioned SQLite migrations and a project repository using Node's built-in SQLite driver.
3. Implement project application services with path canonicalization and directory validation.
4. Expose an allowlisted, runtime-validated IPC API; never expose filesystem, SQL, or raw IPC to the renderer.
5. Build the initial Projects screen with empty, loading, validation, create, edit, and archive states.
6. Add unit tests for input validation and integration tests for repository persistence.

## Commit-sized sequence

1. Tooling and secure Electron window.
2. Shared project contracts and runtime schemas.
3. Migration runner, project repository, and project service.
4. IPC handlers and preload bridge.
5. React projects UI and styling.
6. Tests, build verification, and documentation.

## Acceptance criteria

- The packaged application uses `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- The renderer can call only named project operations through the preload bridge.
- Invalid names, IDs, and paths are rejected in main even if renderer validation is bypassed.
- Project paths are existing directories and uniqueness is based on a canonical path.
- Archive is used instead of destructive deletion.
- Database initialization is migration-driven, uses foreign keys, WAL, and a busy timeout.
- Automated tests cover schema validation, create/update/archive, and canonical-path conflicts.

## Deferred

Claude integration, brainstorm, task queues, scheduling, physical locks, and execution remain in later phases. No placeholder provider behavior is added in Phase 1.
