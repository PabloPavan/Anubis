import { FormEvent, useCallback, useEffect, useState } from "react";
import type { Project, ProjectDraft } from "../../shared/projects";

const emptyDraft: ProjectDraft = {
  name: "",
  path: "",
  provider: "claude",
  workflow: "superpowers",
};

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Something went wrong.";
  const match = error.message.match(/\{.*\}/s);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { message?: string };
      if (parsed.message) return parsed.message;
    } catch {
      // Fall back to the safe Electron error message.
    }
  }
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function Logo(): React.JSX.Element {
  return (
    <div className="logo" aria-label="Anubis">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M14 9 7 3l2 16 7 8-2-18Zm20 0 7-6-2 16-7 8 2-18Z" />
        <path d="M15 14h18l5 10-3 18-11 4-11-4-3-18 5-10Z" />
        <path className="logo-eye" d="m15 27 7 2-6 3-1-5Zm18 0-7 2 6 3 1-5Z" />
      </svg>
      <span>ANUBIS</span>
    </div>
  );
}

interface ProjectFormProps {
  project: Project | null;
  onClose(): void;
  onSaved(): Promise<void>;
}

function ProjectForm({ project, onClose, onSaved }: ProjectFormProps): React.JSX.Element {
  const [draft, setDraft] = useState<ProjectDraft>(() =>
    project
      ? {
          name: project.name,
          path: project.path,
          provider: project.provider,
          workflow: project.workflow,
        }
      : emptyDraft,
  );
  const [pathMessage, setPathMessage] = useState("");
  const [pathValid, setPathValid] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function chooseDirectory(): Promise<void> {
    const path = await window.anubis.projects.selectDirectory();
    if (path) {
      setDraft((current) => ({ ...current, path }));
      setPathMessage("");
      setPathValid(false);
    }
  }

  async function validateDirectory(): Promise<boolean> {
    if (!draft.path.trim()) {
      setPathMessage("Choose a local project folder.");
      setPathValid(false);
      return false;
    }
    const result = await window.anubis.projects.validatePath(draft.path);
    setPathValid(result.valid);
    setPathMessage(result.valid ? "Directory is ready" : (result.message ?? "Invalid directory"));
    if (result.valid && result.canonicalPath) {
      setDraft((current) => ({ ...current, path: result.canonicalPath! }));
    }
    return result.valid;
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      if (!(await validateDirectory())) return;
      if (project) {
        await window.anubis.projects.update({ ...draft, id: project.id, enabled: project.enabled });
      } else {
        await window.anubis.projects.create(draft);
      }
      await onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">LOCAL WORKSPACE</p>
            <h2 id="project-dialog-title">{project ? "Edit project" : "Connect a project"}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Project name
            <input
              autoFocus
              value={draft.name}
              maxLength={120}
              placeholder="Trading Engine"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              required
            />
          </label>
          <label>
            Project directory
            <div className="path-field">
              <input
                value={draft.path}
                placeholder="C:\\Projects\\trading-engine"
                onChange={(event) => {
                  setDraft({ ...draft, path: event.target.value });
                  setPathMessage("");
                  setPathValid(false);
                }}
                required
              />
              <button type="button" className="browse-button" onClick={() => void chooseDirectory()}>Browse</button>
            </div>
          </label>
          {pathMessage && <p className={pathValid ? "field-success" : "field-error"}>{pathValid ? "✓ " : ""}{pathMessage}</p>}
          <div className="form-grid">
            <label>
              Provider
              <select value={draft.provider} disabled>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label>
              Workflow
              <select value={draft.workflow} disabled>
                <option value="superpowers">Superpowers</option>
              </select>
            </label>
          </div>
          <p className="form-hint">Provider and workflow are fixed for the first release. Your source stays on this machine.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <footer className="dialog-actions">
            <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
            <button className="button primary" disabled={saving}>{saving ? "Saving…" : project ? "Save changes" : "Add project"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formProject, setFormProject] = useState<Project | "new" | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      setError("");
      setProjects(await window.anubis.projects.list());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void loadProjects(), [loadProjects]);

  async function archive(project: Project): Promise<void> {
    if (!window.confirm(`Archive ${project.name}? You can keep its local files.`)) return;
    try {
      await window.anubis.projects.archive(project.id);
      await loadProjects();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const activeProjects = projects.filter((project) => project.enabled);
  const archivedProjects = projects.filter((project) => !project.enabled);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <nav aria-label="Main navigation">
          <button className="nav-item active"><span className="nav-icon">◇</span>Projects</button>
          <button className="nav-item" disabled><span className="nav-icon">!</span>Attention<span className="soon">Soon</span></button>
          <button className="nav-item" disabled><span className="nav-icon">≡</span>History<span className="soon">Soon</span></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-badge"><span className="status-dot" />Local only</div>
          <p>Phase 1 · Projects</p>
        </div>
      </aside>

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">WORKSPACES</p>
            <h1>Projects</h1>
            <p className="subtitle">Connect local repositories and prepare them for orchestrated work.</p>
          </div>
          <button className="button primary" onClick={() => setFormProject("new")}><span>＋</span>Add project</button>
        </header>

        {error && <div className="error-banner page-error" role="alert">{error}<button onClick={() => void loadProjects()}>Try again</button></div>}

        {loading ? (
          <section className="loading-state"><div className="spinner" />Loading projects…</section>
        ) : activeProjects.length === 0 ? (
          <section className="empty-state">
            <div className="empty-mark"><span>◇</span></div>
            <p className="eyebrow">NO PROJECTS YET</p>
            <h2>Bring your first codebase</h2>
            <p>Anubis works directly inside a local folder. Add a project to begin—nothing leaves your machine.</p>
            <button className="button primary" onClick={() => setFormProject("new")}>Choose a project folder</button>
            <div className="empty-features">
              <span>✓ Existing folder</span><span>✓ Windows paths</span><span>✓ Local SQLite</span>
            </div>
          </section>
        ) : (
          <section className="project-section">
            <div className="section-heading">
              <h2>Active projects</h2>
              <span>{activeProjects.length} {activeProjects.length === 1 ? "workspace" : "workspaces"}</span>
            </div>
            <div className="project-grid">
              {activeProjects.map((project) => (
                <article className="project-card" key={project.id}>
                  <div className="project-card-top">
                    <div className="project-symbol">{project.name.slice(0, 2).toUpperCase()}</div>
                    <div className="project-state"><span className="status-dot" />Idle</div>
                  </div>
                  <h3>{project.name}</h3>
                  <p className="project-path" title={project.path}>{project.path}</p>
                  <div className="tags"><span>Claude</span><span>Superpowers</span></div>
                  <footer>
                    <span>Ready for tasks</span>
                    <div>
                      <button className="text-button" onClick={() => setFormProject(project)}>Edit</button>
                      <button className="text-button danger" onClick={() => void archive(project)}>Archive</button>
                    </div>
                  </footer>
                </article>
              ))}
            </div>
          </section>
        )}

        {archivedProjects.length > 0 && (
          <details className="archived-section">
            <summary>Archived projects <span>{archivedProjects.length}</span></summary>
            {archivedProjects.map((project) => <p key={project.id}>{project.name}<small>{project.path}</small></p>)}
          </details>
        )}
      </main>

      {formProject && (
        <ProjectForm
          project={formProject === "new" ? null : formProject}
          onClose={() => setFormProject(null)}
          onSaved={loadProjects}
        />
      )}
    </div>
  );
}
