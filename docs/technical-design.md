# AI Task Orchestrator — Technical Design

**Status:** Approved — Phase 1 implementation started
**Target:** Windows desktop MVP
**Initial provider/workflow:** Claude Agent SDK / Superpowers
**Decision boundary:** This document defines architecture and invariants. It is not the implementation plan; a file-by-file implementation plan will be produced only after this design is approved.

## 1. Executive summary

The product is a local Electron application that coordinates durable development tasks against local project folders. The orchestrator, not the agent, owns the queue and task lifecycle. A project may have many queued or suspended tasks, but its folder may have at most one live top-level execution lease. Subagents spawned inside that execution remain the provider's concern and are allowed.

The core design is a modular monolith with a React renderer and a privileged Electron main process. SQLite is the source of truth for projects, tasks, sessions, questions, transitions, and important events. Specs, plans, source, tests, and Git history remain durable project artifacts. Agent conversation state is explicitly temporary.

Two identifiers and two lifecycle concepts must never be conflated:

- an orchestrator `session.id` is local and stable;
- a `provider_session_id` is opaque and understood only by its provider;
- a **new task execution** always starts a new provider session;
- a suspended task may resume only its own execution session, after an answered question or an explicitly supported recovery action.

The initial delivery should prove these invariants before adding rich observability.

## 2. Scope and non-goals

### In scope

- Local project registration and validation.
- Interactive brainstorm, approved spec, per-project task queue, serial execution, and verification.
- Normalized provider events and a Superpowers workflow adapter.
- Structured human questions, suspension, answer, and same-task resume.
- Physical folder lease plus transactional database coordination.
- Windows process ownership, cancellation, shutdown, and recovery.
- Secure typed Electron IPC and local-only persistence.

### Explicit non-goals for the MVP

- Multiple top-level agents in one folder, automatic worktrees, or a general swarm.
- Remote control plane, HTTP server, cloud database, Redis, Docker, or distributed scheduling.
- Cross-project dependency graphs or transactional source-code rollback.
- Codex/Gemini implementations. Only their future insertion points are preserved.
- Persisting every streaming token forever.
- Treating an agent session as durable task memory.

## 3. Architectural principles and invariants

1. **Folder exclusivity:** the canonical project path, not merely `project_id`, is the isolation key.
2. **Fresh execution:** a task with no execution session can be started only by creating a new provider session.
3. **Resume ownership:** a provider session belongs to exactly one task; APIs reject cross-task resume.
4. **Durable artifacts:** spec and plan are different files. A spec exists before queueing; a plan is generated from current code after execution begins.
5. **Transactional lifecycle:** every status mutation is validated and recorded in the same SQLite transaction.
6. **Provider opacity:** scheduler, repositories, IPC, and renderer never import Claude SDK types.
7. **Workflow opacity:** scheduler asks a workflow to run stages; it does not know skill names or prompt syntax.
8. **Least privilege:** only Electron main accesses filesystem, SQLite, SDK, and child processes.
9. **Fail closed:** ambiguous locks, session ownership, or recovery states do not cause automatic execution.
10. **One scheduler authority:** one in-process scheduler service performs claims; UI requests intent rather than writing state.

## 4. System architecture

```text
┌──────────────── React renderer ────────────────┐
│ pages / view models / ephemeral stream buffers │
└──────────────────────┬─────────────────────────┘
                       │ typed, validated IPC
┌──────────────────────▼ Electron main ──────────┐
│ Application services                          │
│  ProjectService  BrainstormService             │
│  TaskService     AttentionService              │
│                       │                        │
│ Scheduler ── ExecutionCoordinator ── Workflow  │
│    │                  │                  │      │
│ folder lease     ProcessRegistry     AgentProvider
│    │                  │                  │      │
│ repositories ─ SQLite/Event journal   ClaudeProvider
└────────────────────────────────────────┬───────┘
                                         │
                                Claude Agent SDK
```

This is a modular monolith. Interfaces are introduced only at external or policy boundaries: `AgentProvider`, `DevelopmentWorkflow`, `ProjectRepository`, `TaskRepository`, `EventBus`, `FolderLease`, and `OwnedProcessController`. Application services may use concrete implementations through constructor injection without creating an interface for every class.

### 4.1 Responsibilities

- **Renderer:** queries projections, sends commands, renders normalized snapshots/events, and holds transient token chunks. It never decides legal task transitions.
- **Application services:** validate use cases and transaction boundaries, authorize task/session relationships, and return renderer-safe DTOs.
- **Scheduler:** selects runnable work and requests an atomic claim. It knows statuses and fairness, but not Superpowers or Claude.
- **ExecutionCoordinator:** owns one active run, physical lease, provider session, event pump, cancellation, and terminal cleanup.
- **Workflow:** creates prompts and interprets normalized outcomes for brainstorm, planning, execution, and verification.
- **Provider:** manages SDK-specific sessions and converts SDK messages/tools/errors into normalized events.
- **Repositories:** persist domain records and implement compare-and-set claims/transitions.
- **Event bus:** publishes live normalized events and sends persistence-worthy events to the journal writer.

### 4.2 Key domain APIs

```ts
interface AgentProvider {
  readonly id: string;
  startSession(input: StartSessionInput): Promise<StartedAgentSession>;
  resumeSession(input: ResumeSessionInput): Promise<ResumedAgentSession>;
  sendMessage(session: ProviderSessionRef, message: AgentInput): Promise<void>;
  answerQuestion(session: ProviderSessionRef, answer: UserAnswer): Promise<void>;
  events(session: ProviderSessionRef, signal: AbortSignal): AsyncIterable<AgentEvent>;
  cancel(session: ProviderSessionRef, reason: string): Promise<void>;
  capabilities(): AgentCapabilities;
}

interface DevelopmentWorkflow {
  readonly id: string;
  brainstorm(context: BrainstormContext): Promise<WorkflowDirective>;
  createPlan(context: ExecutionContext): Promise<WorkflowDirective>;
  execute(context: ExecutionContext): Promise<WorkflowDirective>;
  verify(context: ExecutionContext): Promise<WorkflowDirective>;
}
```

`ProviderSessionRef` is constructed inside main from a database session after verifying its task/provider ownership. The renderer never supplies an arbitrary provider session ID. `AgentCapabilities` exposes facts such as structured questions, resume, subagent events, and cancellation so workflows can degrade deliberately instead of relying on provider-specific checks.

## 5. Claude isolation boundary

The following are Claude-specific and must remain inside `main/providers/claude`:

- SDK imports, authentication/environment discovery, executable discovery, and SDK configuration.
- Start/resume mechanics and the exact meaning/format of Claude session IDs.
- Claude stream/message/content-block types and incremental text assembly.
- Tool names, tool input/output schemas, and correlation of tool start/result blocks.
- Mapping an `AskUserQuestion`-like tool into `AgentQuestion`, including whether answering is a tool result, resumed prompt, or SDK control message.
- Mapping Claude task/subagent tools to optional normalized subagent events.
- Permission modes, allowed/disallowed tools, hooks, model/options, `CLAUDE.md` behavior, and Superpowers availability detection.
- SDK abort semantics, error taxonomy, rate/auth failures, exit/result records, usage metadata, and process handles.
- Any Claude CLI/native Windows process launched by the SDK.

The exact Agent SDK contract is version-sensitive. Before Phase 2, an adapter spike must pin a supported SDK version and contract-test start, streaming, structured question handling, resume after process teardown, cancellation, subagent visibility, and Windows child-process ownership. Unsupported observations become capability flags; they must not leak into core types as guesses.

`SuperpowersWorkflow` may refer to Superpowers skill names, but may not import SDK types. It produces provider-neutral instructions and consumes normalized events/results. Configuration validation should report separately whether Claude is available and whether the required Superpowers skills are available.

## 6. Internal event model

All events share an envelope so they can be ordered, correlated, versioned, filtered, and safely replayed:

```ts
interface AgentEventEnvelope<T extends AgentEvent = AgentEvent> {
  eventId: string;          // application-generated UUID
  schemaVersion: 1;
  occurredAt: string;       // UTC ISO-8601
  projectId: string;
  taskId: string;
  sessionId: string;        // local session id, never provider id
  sequence: number;         // monotonic within local session
  persistence: "EPHEMERAL" | "DURABLE";
  payload: T;
}
```

```ts
type AgentEvent =
  | { type: "message_delta"; messageId: string; text: string }
  | { type: "message_completed"; messageId: string; text?: string }
  | { type: "thinking_status"; text?: string }
  | { type: "stage_changed"; stage: WorkflowStage }
  | { type: "tool_started"; callId: string; tool: string; detail?: string }
  | { type: "tool_finished"; callId: string; tool: string; detail?: string }
  | { type: "tool_failed"; callId: string; tool: string; error: SafeError }
  | { type: "file_changed"; path: string; change?: "created" | "modified" | "deleted" }
  | { type: "command_started"; callId: string; command: string }
  | { type: "command_finished"; callId: string; command: string; exitCode: number }
  | { type: "question_asked"; question: AgentQuestion }
  | { type: "question_answered"; questionId: string }
  | { type: "subagent_started"; subagentId: string; name?: string; role?: string }
  | { type: "subagent_finished"; subagentId: string; name?: string; outcome?: string }
  | { type: "plan_updated"; revision: number; items: PlanItem[] }
  | { type: "verification_result"; passed: boolean; summary: string }
  | { type: "session_started" }
  | { type: "session_suspended"; reason: "WAITING_USER" | "INTERRUPTED" }
  | { type: "session_resumed" }
  | { type: "session_finished"; outcome: "COMPLETED" | "CANCELLED" | "FAILED" }
  | { type: "completed"; summary?: string }
  | { type: "failed"; error: SafeError; classification: FailureClass };
```

Important rules:

- Store finalized user/assistant messages needed for brainstorm continuity, but batch or discard deltas after finalization.
- Persist lifecycle, questions/answers, stages, plan revisions, subagent lifecycle, failed commands/tools, verification, and terminal outcomes.
- Successful high-volume reads/searches and thinking indicators are live by default; optional rolling log files may retain them with size/age limits.
- Redact secrets and cap payload sizes before both IPC and persistence. Commands may contain secrets and require redaction.
- Unknown provider events become diagnostic logs, never fabricated semantic events.
- Live IPC carries a bounded stream. On subscriber overflow, drop/coalesce ephemeral updates and emit a `projection-invalidated` notification; never drop durable lifecycle events.

## 7. Task state machine

Add `INTERRUPTED`; it distinguishes an execution whose app/process continuity was lost from a provider-reported failure. Keep queue pause as `is_paused`, not another lifecycle status.

```text
DRAFT -> BRAINSTORMING -> DESIGN_REVIEW -> QUEUED
  |          |                 |            |
  +----------+-----------------+----------> CANCELLED

QUEUED -> PLANNING -> EXECUTING -> VERIFYING -> DONE
             |           |           |
             +-----------+-----------+-> WAITING_USER -> READY_TO_RESUME
             |           |           |                       |
             |           |           |                       +-> prior active stage
             +-----------+-----------+-> BLOCKED
             +-----------+-----------+-> FAILED
             +-----------+-----------+-> INTERRUPTED

INTERRUPTED -> READY_TO_RESUME | QUEUED (new session, explicit retry) | FAILED | CANCELLED
BLOCKED     -> QUEUED (explicit retry) | CANCELLED
FAILED      -> QUEUED (explicit retry) | CANCELLED
```

### 7.1 Transition constraints

- `DESIGN_REVIEW -> QUEUED` requires an approved, project-relative spec path, a content hash, and recorded approval time.
- `QUEUED -> PLANNING` requires an atomic database claim, a newly created `EXECUTION` session, and an acquired physical lease.
- An execution question records `resume_stage` (`PLANNING`, `EXECUTING`, or `VERIFYING`) before moving to `WAITING_USER`.
- `WAITING_USER -> READY_TO_RESUME` requires all blocking questions for that suspension to have valid answers.
- `READY_TO_RESUME -> resume_stage` requires the same task, same nonterminal execution session, provider resume capability, and the folder lease.
- `VERIFYING -> DONE` requires a terminal provider outcome plus a persisted verification summary. “Agent said done” alone is insufficient.
- `CANCELLED`, `DONE`, and `FAILED` are terminal for an attempt. Retrying creates a new attempt/session and transitions the task back to `QUEUED`; history is retained.
- `BLOCKED` never auto-retries. `INTERRUPTED` never auto-resumes without a recovery policy and verified capability.

Store a `task_transitions` audit row for every transition, including `from_status`, `to_status`, reason, actor, and revision. Use `tasks.revision` for optimistic concurrency.

## 8. Scheduling and folder lease

The scheduler is event-driven (queue/status/answer/completion changes) with a low-frequency reconciliation tick. It evaluates each enabled project independently.

Runnable ordering:

1. `READY_TO_RESUME`, ordered by `answered_at`, with an aging cap to prevent permanent starvation;
2. `QUEUED`, ordered by `priority DESC`, `position ASC`, `created_at ASC`.

Claim sequence:

1. Resolve and canonicalize the project directory (absolute path, normalized separators/case, final path where feasible).
2. Begin an immediate SQLite transaction and verify no active lease/task exists for the canonical path.
3. Insert a short-lived database execution lease/claim with owner instance ID and incremented fencing token; commit.
4. Atomically create `.project-agent.lock` using exclusive-create semantics. The file contains schema version, instance ID, project/task/attempt IDs, PID, process-start fingerprint, fencing token, and timestamps.
5. Revalidate the database claim, then start/resume the provider and attach its owned process metadata.
6. Heartbeat the DB lease and lock metadata. If any step fails, compensate by releasing only resources owned by this instance/fencing token.

The PID alone is unsafe because Windows reuses PIDs. Stale detection requires PID plus process-start fingerprint and app instance ownership. An unverifiable existing lock is treated as occupied and shown for manual recovery. Lock removal uses compare-owner semantics; the app never blindly deletes another owner's lock.

When a task asks a question, the coordinator records and suspends it, stops/detaches the provider according to its documented suspend contract, releases the lease, and lets another queued task run. A later answer does not preempt current work; it sets `READY_TO_RESUME` for the next free slot.

## 9. End-to-end brainstorm flow

1. User selects a validated project and creates a draft.
2. Main creates a `BRAINSTORM` session and starts a **fresh** provider session with `cwd` equal to the project root.
3. `SuperpowersWorkflow.brainstorm` supplies the “design only, inspect as needed, clarify, do not implement” contract and configured spec directory.
4. Provider events stream through the normalizer. Completed chat messages are persisted; deltas are ephemeral. Structured questions are persisted and rendered as controls, with free-form fallback.
5. User messages/answers are sent only after main verifies project/task/session ownership. The same brainstorm session remains active for this draft.
6. Workflow proposes a spec. The app reads it through a safe project-root path resolver, displays it, and records its content hash. The agent may not mark it approved.
7. User can request revisions or explicitly approve. Approval is an application action, not a chat inference.
8. In one transaction, record approval/hash, close the brainstorm session, transition `DESIGN_REVIEW -> QUEUED`, and assign queue position/provider/workflow snapshots.
9. The scheduler is notified. The brainstorm session is never reused as the execution session.

If the spec file changes after approval, execution detects a hash mismatch and returns the task to design review or requests explicit reapproval; it must not silently execute altered requirements.

## 10. End-to-end execution flow

1. Scheduler selects and claims a queued task and folder.
2. Coordinator creates a new execution attempt and a **new** provider session. It passes only current-task metadata and the approved spec path—never queue contents.
3. Workflow enters `PLANNING`, inspects current repository state, validates spec compatibility, and invokes writing-plans instructions. The plan is written to a configured project path and its hash/path are persisted.
4. A meaningful product/architecture ambiguity yields a structured question. Mechanical implementation choices remain with the agent under workflow policy.
5. With a valid plan, workflow enters `EXECUTING` and requests subagent-driven development. Normalized plan, tools, files, commands, and optional subagent events update projections.
6. Workflow enters `VERIFYING`, runs relevant tests/checks, and records commands, exit codes, and a verification summary.
7. Success closes the session/attempt, transitions to `DONE`, releases process and folder resources, and wakes the scheduler.
8. Provider/tool/test failure is classified as `FAILED`, `BLOCKED`, or `INTERRUPTED`; cleanup is identical and recorded before the next task is considered.

The coordinator uses `try/finally`-style lifecycle cleanup around runtime work, but imports remain ordinary static imports. Database transitions are idempotent so duplicate terminal events cannot complete a task twice.

## 11. WAITING_USER and same-task resume

Question handling is a durable handshake, not merely a UI event:

1. Provider emits a question with provider correlation data kept in an encrypted/redacted provider payload if needed.
2. In one transaction, insert `questions(PENDING)`, store `resume_stage`, append durable events, and transition the task to `WAITING_USER`.
3. Acknowledge/suspend provider work, end the local event pump, and release the folder lease. If safe suspension cannot be confirmed, classify as `BLOCKED` rather than running another task concurrently.
4. UI attention projection shows the question and options.
5. `questions.answer` validates schema and atomically changes `PENDING -> ANSWERED` and task `WAITING_USER -> READY_TO_RESUME`. Answers are immutable; correction creates a superseding record before resume.
6. When the folder becomes free, scheduler claims the same task. Main loads its exact latest execution session and checks `session.task_id`, provider, attempt, nonterminal state, and resume capability.
7. Provider resumes that opaque session, main submits the correlated answer, emits `session_resumed`, and returns to `resume_stage`.
8. If provider reports the session missing/unresumable, transition to `INTERRUPTED`. The user may explicitly retry with a new execution session based on durable spec/current repository, but the app must disclose loss of conversational context.

An answer never resumes a brainstorm session as an execution session and never resumes another task's session.

## 12. Crash recovery and shutdown

Each app launch gets an `app_instance_id`. On startup, recovery runs before scheduling:

1. Open/migrate SQLite, acquire a singleton application/recovery guard, and disable scheduling.
2. Enumerate nonterminal attempts/tasks (`PLANNING`, `EXECUTING`, `VERIFYING`, and claims) plus all project lock files.
3. Correlate DB lease, lock owner/fencing token, PID/start fingerprint, and owned-process registry.
4. If a known owned process is alive, do not spawn another. Reattach only if the SDK explicitly supports it; otherwise attempt controlled termination and mark `INTERRUPTED`.
5. If process is absent and ownership is proven stale, archive/remove the lock with compare-owner checks and mark the attempt `INTERRUPTED`.
6. If ownership is ambiguous, preserve the lock, mark/project an operator-attention condition, and do not schedule that folder.
7. Leave `WAITING_USER` intact. Validate that its session/question records exist. Leave `READY_TO_RESUME` runnable only when provider resume is supported.
8. Rebuild read projections from database/event data, then enable scheduling.

On normal shutdown, stop new claims, cancel or gracefully suspend active sessions within a timeout, terminate only registered process trees, persist final attempt state, and release owned locks. Windows termination uses explicit handles/job objects when feasible, with a tracked root PID fallback (`taskkill /PID <ownedPid> /T`) only after identity verification. Never search and kill processes by executable name.

Recovery policy defaults to human-visible `INTERRUPTED`, not silent resume or `FAILED`. Explicit options are:

- **Resume same attempt/session** when provider capability and ownership are verified;
- **Retry as new attempt/session** from the durable spec and current repo;
- **Mark failed/cancelled**;
- **Resolve ambiguous lock** after showing evidence.

## 13. SQLite design

Use SQLite in WAL mode, foreign keys enabled, a busy timeout, UTC timestamps, and numbered migrations. IDs are UUID/ULID text except human-friendly per-project `task_number`. JSON is validated at application boundaries. Paths are stored absolute for project roots and project-relative for artifacts.

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  provider TEXT NOT NULL DEFAULT 'claude',
  workflow TEXT NOT NULL DEFAULT 'superpowers',
  spec_directory TEXT NOT NULL DEFAULT 'docs/superpowers/specs',
  plan_directory TEXT NOT NULL DEFAULT 'docs/superpowers/plans',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
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
  is_paused INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0,1)),
  provider TEXT NOT NULL,
  workflow TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(project_id, task_number)
);

CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome_summary TEXT,
  UNIQUE(task_id, attempt_number)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_session_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('BRAINSTORM','EXECUTION')),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  suspended_at TEXT,
  ended_at TEXT
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider_question_ref TEXT,
  prompt TEXT NOT NULL,
  context TEXT,
  options_json TEXT,
  answer_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','ANSWERED','SUBMITTED','CANCELLED')),
  created_at TEXT NOT NULL,
  answered_at TEXT,
  submitted_at TEXT
);

CREATE TABLE task_transitions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  sequence INTEGER,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, sequence)
);

CREATE TABLE execution_leases (
  canonical_path TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  owner_instance_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  owner_pid INTEGER NOT NULL,
  process_fingerprint TEXT,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
```

Recommended indexes:

```sql
CREATE INDEX idx_tasks_runnable
  ON tasks(project_id, status, is_paused, priority DESC, position, created_at);
CREATE INDEX idx_tasks_attention ON tasks(status, updated_at);
CREATE INDEX idx_sessions_task_type ON sessions(task_id, type, created_at DESC);
CREATE INDEX idx_questions_pending ON questions(status, created_at);
CREATE INDEX idx_events_task_time ON events(task_id, occurred_at DESC);
CREATE INDEX idx_transitions_task_time ON task_transitions(task_id, created_at);
```

Status values are enforced by repository transition code initially; a migration can add lookup/check constraints once evolution stabilizes. Deleting a project with task history is disallowed; “remove” archives/disables it unless it has no history.

## 14. Electron IPC and security

Browser window configuration:

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: PRELOAD_PATH
}
```

Use an explicit preload allowlist and `contextBridge`. No generic `invoke(channel, ...args)`, filesystem API, shell API, SQL, provider object, or raw event emitter is exposed. Each request/response and pushed event is runtime-validated (for example with Zod) in addition to TypeScript typing. Validate UUIDs, enums, lengths, and project-root-contained paths in main.

Suggested versioned API:

```text
projects:list/get/create/update/archive/validate-path/select-directory
tasks:list/get/reorder/set-priority/set-paused/cancel/retry
brainstorm:create/send/answer/cancel/get-transcript/get-spec/approve-and-queue
questions:list-attention/answer
executions:get-snapshot/cancel/get-history
events:subscribe/unsubscribe
app:get-capabilities/get-health
```

`events:subscribe` accepts domain filters (`projectId`, `taskId`) and returns a generated subscription token. Push messages contain renderer-safe normalized envelopes. Navigation/disposal unsubscribes. Commands return discriminated results with stable error codes, never stack traces.

Additional controls:

- Disable unexpected navigation/window creation and restrict external links to an explicit confirmation flow.
- Apply a restrictive Content Security Policy and package the preload path immutably.
- Treat Markdown as untrusted: sanitize HTML, escape code, and never execute rendered links/content.
- Resolve artifact paths under the canonical project root; reject traversal, device paths, and unexpected UNC paths according to project policy.
- Do not expose provider session IDs or secrets to the renderer.

## 15. Windows-specific process and filesystem design

- Normalize paths with Node path APIs; never manually concatenate `\`. Preserve a display path separately from the canonical exclusivity key.
- Validate that a project is a directory and writable where artifacts/lock are needed; Git may be recommended but should be an explicit project capability unless required.
- Use UTF-8 for app-authored files and JSON. Do not assume PowerShell output encoding.
- Avoid shell command strings where argument arrays suffice. If PowerShell is required, invoke a known executable with explicit arguments and quoting.
- Maintain an `OwnedProcessRegistry` containing launch ID, task/attempt/session, PID, start fingerprint, and process/job handle. Cancellation targets that ownership record only.
- Prefer Windows Job Objects for kill-on-close/process-tree containment if supported by the chosen native dependency; otherwise verify the root process then use a narrow tree termination fallback.
- Test drive-letter case, spaces, Unicode, UNC policy, symlinks/junctions, long paths, read-only folders, antivirus lock contention, and abrupt app termination.
- The lock file is runtime coordination metadata and should normally be added to project `.git/info/exclude` (local only), not automatically modify the tracked `.gitignore`.

## 16. Directory structure

```text
docs/
  technical-design.md
src/
  main/
    bootstrap/                 # Electron startup, composition root, recovery
    application/               # use-case services and DTO mapping
    scheduler/                 # selection, fairness, reconciliation
    execution/                 # coordinator, attempts, lifecycle
    providers/
      agent-provider.ts
      provider-registry.ts
      claude/
        claude-provider.ts
        claude-event-mapper.ts
        claude-process-adapter.ts
    workflows/
      development-workflow.ts
      workflow-registry.ts
      superpowers/
        superpowers-workflow.ts
        prompts.ts
    repositories/              # repository contracts + SQLite implementations
    database/                  # connection and numbered migrations
    events/                    # bus, journal policy, projections
    processes/                 # owned process registry and Windows termination
    locks/                     # physical/DB folder lease
    ipc/                       # handlers and validation
  preload/
    index.ts                   # minimal contextBridge
  renderer/
    app/
    pages/
    components/
    features/                  # projects, brainstorm, queue, attention, execution
    stores/                    # server projections + ephemeral streams
  shared/
    domain/                    # statuses, events, questions, plans
    ipc/                       # channel names, DTO schemas, error codes
    validation/
tests/
  unit/
  integration/
  contract/                    # provider/workflow contracts
  e2e/
```

Shared code contains serializable contracts only and must not import Electron main, Node filesystem/process APIs, SQLite, or any provider SDK.

## 17. Risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| SDK session/resume semantics differ from assumptions | Lost task context or unsafe reuse | Phase 2 contract spike, pinned version, capability flags, opaque provider IDs |
| “Question” does not truly suspend provider execution | Two agents may touch one folder | Confirm suspend/termination before lease release; fail closed to `BLOCKED` |
| PID reuse/stale lock | False ownership and accidental process kill | Start fingerprint, fencing token, instance ID, compare-owner cleanup |
| Agent bypasses workflow instructions | Implements during brainstorm or reads unrelated work | Minimal prompt context, permission/tool policy where supported, artifact checks, user approval gate |
| Concurrent DB/UI callbacks race transitions | Invalid state/history | Single scheduler authority, immediate transactions, optimistic revision, transition table |
| Approved spec drifts | Wrong requirements executed | Store hash and require reapproval on mismatch |
| Current code diverges while queued | Stale plan/design | Generate plan only at start; compatibility review and structured question |
| Event volume freezes UI/grows DB | Poor reliability | Delta coalescing, bounded queues, persistence policy, pagination/retention |
| Secrets appear in commands/logs | Local data exposure | Redaction, payload limits, restricted renderer DTOs, configurable retention |
| Native SQLite/job-object packaging on Windows | Install/build failures | Early CI on clean Windows, pinned Electron ABI-compatible dependencies |
| Cancellation leaves descendants | Continued mutation after release | Owned process registry, job objects/tree kill, wait for confirmed exit before unlock |
| Folder aliases/junctions bypass uniqueness | Parallel agents in same physical folder | canonical/final path key and uniqueness; test alias cases |
| WAL/database corruption or migration failure | Lost orchestration state | transactional migrations, backups, integrity check, recovery UI |
| Superpowers unavailable/misconfigured | Workflow cannot run | startup health/capability check and actionable `BLOCKED`, no silent fallback |

## 18. Incremental delivery roadmap

This is a phase and acceptance-gate roadmap, not the post-approval detailed implementation plan.

### Phase 0 — Foundations and contract spikes

- Choose Electron/React build tooling, SQLite library, validation library, test runner, and packaging approach.
- Pin and contract-test the Claude Agent SDK on Windows.
- Establish domain IDs, status transition table, migration harness, structured logs, and CI on Windows.
- **Gate:** verified answers for SDK start/stream/question/resume/cancel/process ownership; architecture decision records updated.

### Phase 1 — Secure shell and projects

- Electron/preload/renderer skeleton, SQLite migrations, project CRUD/archive, path picker and validation.
- **Gate:** packaged Windows app opens; IPC security settings and project repository integration tests pass.

### Phase 2 — Provider vertical slice

- `AgentProvider`, `ClaudeProvider`, normalized event mapper, session persistence, stream/cancel/error demo, provider contract tests.
- **Gate:** one controlled session streams and cancels; no Claude types cross the adapter.

### Phase 3 — Brainstorm and spec approval

- Superpowers brainstorm workflow, chat projection, structured questions, Markdown, safe spec preview, explicit approval/hash.
- **Gate:** brainstorm cannot queue without approved durable spec and cannot execute code through application controls.

### Phase 4 — Queue, transitions, scheduler, and leases

- Task CRUD/order/priority/pause/history, transition validator, atomic claim, DB/physical lease, basic recovery.
- **Gate:** concurrency stress test proves at most one top-level claim per canonical folder.

### Phase 5 — Execution vertical slice

- Fresh execution session, current-code planning, plan artifact, execute/verify, terminal cleanup and automatic next task.
- **Gate:** two queued tasks run serially with distinct provider session IDs and independently persisted artifacts.

### Phase 6 — Human intervention and resume

- Durable questions, attention UI, release-on-confirmed-suspension, `READY_TO_RESUME` fairness, same-session resume.
- **Gate:** task A waits, task B runs, then A resumes its own session; no folder overlap occurs.

### Phase 7 — Observability

- Execution projections for stages, plan, subagents, tools, commands, files, tests, elapsed time, paged logs/history.
- **Gate:** renderer remains responsive under a high-volume synthetic stream and reconstructs state after reload.

### Phase 8 — Hardening and release

- Crash recovery, ambiguous/stale lock UI, orphan cleanup, migration backup/integrity, retention/redaction, installer/update strategy.
- **Gate:** forced-kill recovery matrix passes on Windows and never silently starts a second owner.

After approval, the implementation plan should break only the next phase into small, testable commits with exact files, APIs, migrations, tests, and rollback notes. Later phases should be replanned against the then-current codebase.

## 19. Design acceptance criteria

The design is ready for implementation planning when stakeholders approve these decisions:

- modular-monolith boundary and provider/workflow responsibilities;
- canonical folder as exclusivity key with DB lease plus physical lock;
- `INTERRUPTED` and attempt history semantics;
- confirmed suspension required before a waiting task releases its folder;
- resume priority/fairness policy;
- explicit spec approval and hash-drift behavior;
- SQLite schema, event retention boundary, and local artifact paths;
- Windows process-tree containment approach selected by the Phase 0 spike;
- provider inability to resume produces `INTERRUPTED`, never cross-task/new-task session reuse.

## 20. Open decisions to resolve at approval

1. Should projects outside Git repositories be allowed, warned, or rejected?
2. Should ambiguous stale locks require manual confirmation in all cases, or may proven-dead same-instance locks be auto-archived?
3. What maximum wait should `READY_TO_RESUME` have before priority aging overrides newly queued work?
4. Should specs/plans be committed by the agent, by the app, or left uncommitted under project policy?
5. What detailed-log retention limit is acceptable (days and disk size), and which command fields require custom redaction?
6. Is UNC/network-share execution supported in the MVP or explicitly deferred?
7. Which exact Claude Agent SDK version and Windows process-containment mechanism pass the Phase 0 contract spike?
