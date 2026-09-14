export const providerIds = ["claude", "gemini"] as const;
export const workflowIds = ["superpowers", "antigravity", "skills"] as const;

export type ProviderId = (typeof providerIds)[number];
export type WorkflowId = (typeof workflowIds)[number];

export const providerWorkflows: Record<ProviderId, readonly WorkflowId[]> = {
  claude: ["superpowers"],
  gemini: ["antigravity", "skills", "superpowers"],
};

export const defaultWorkflowByProvider: Record<ProviderId, WorkflowId> = {
  claude: "superpowers",
  gemini: "antigravity",
};

export interface Project {
  id: string;
  name: string;
  path: string;
  provider: ProviderId;
  workflow: WorkflowId;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDraft {
  name: string;
  path: string;
  provider: ProviderId;
  workflow: WorkflowId;
}

export interface ProjectUpdate extends ProjectDraft {
  id: string;
  enabled: boolean;
}

export interface PathValidation {
  valid: boolean;
  canonicalPath?: string;
  message?: string;
}

export interface ProjectApi {
  list(): Promise<Project[]>;
  validatePath(path: string): Promise<PathValidation>;
  selectDirectory(): Promise<string | null>;
  create(input: ProjectDraft): Promise<Project>;
  update(input: ProjectUpdate): Promise<Project>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<Project>;
}

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError("Expected an object.");
  }
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new InputValidationError(`${field} must be text.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new InputValidationError(`${field} must contain between 1 and ${maximum} characters.`);
  }
  if (normalized.includes("\0")) {
    throw new InputValidationError(`${field} contains an invalid character.`);
  }
  return normalized;
}

export function parseProjectDraft(value: unknown): ProjectDraft {
  assertRecord(value);
  const provider = requiredString(value.provider, "Provider", 32);
  const workflow = requiredString(value.workflow, "Workflow", 32);
  if (!providerIds.includes(provider as ProviderId)) {
    throw new InputValidationError("Unsupported provider.");
  }
  if (!workflowIds.includes(workflow as WorkflowId)) {
    throw new InputValidationError("Unsupported workflow.");
  }
  const allowedWorkflows = providerWorkflows[provider as ProviderId];
  if (!allowedWorkflows?.includes(workflow as WorkflowId)) {
    throw new InputValidationError("Unsupported workflow for the selected provider.");
  }
  return {
    name: requiredString(value.name, "Name", 120),
    path: requiredString(value.path, "Path", 32_767),
    provider: provider as ProviderId,
    workflow: workflow as WorkflowId,
  };
}

export function parseProjectUpdate(value: unknown): ProjectUpdate {
  assertRecord(value);
  if (typeof value.enabled !== "boolean") {
    throw new InputValidationError("Enabled must be a boolean.");
  }
  return {
    ...parseProjectDraft(value),
    id: parseProjectId(value.id),
    enabled: value.enabled,
  };
}

export function parseProjectId(value: unknown): string {
  const id = requiredString(value, "Project ID", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new InputValidationError("Project ID is invalid.");
  }
  return id;
}

export function parsePath(value: unknown): string {
  return requiredString(value, "Path", 32_767);
}
