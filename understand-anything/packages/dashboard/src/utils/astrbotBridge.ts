export interface AstrBotPluginPageBridge {
  ready: () => Promise<unknown>;
  apiGet: (endpoint: string, params?: Record<string, unknown>) => Promise<unknown>;
  apiPost?: (endpoint: string, body?: Record<string, unknown>) => Promise<unknown>;
  subscribeSSE?: (
    endpoint: string,
    handlers: {
      onMessage?: (event: { parsed: unknown; raw: string }) => void;
      onError?: () => void;
      onOpen?: () => void;
    },
    params?: Record<string, unknown>,
  ) => Promise<string>;
  unsubscribeSSE?: (subscriptionId: string) => Promise<unknown>;
}

export interface ProjectRefParams {
  project_id?: string;
  project_name?: string;
  project_path?: string;
  project?: string;
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  aliases?: string[];
  path?: string;
  graph_root?: string;
  last_job_id?: string | null;
  last_analyzed_at?: number | null;
  auto_update?: boolean;
}

export interface PluginStatus {
  plugin: {
    name: string;
    display_name: string;
  };
  config: {
    provider_configured: boolean;
    node_bin: string;
    pnpm_bin: string;
    auto_build: boolean;
    auto_update_poll_interval: number;
    max_concurrent_jobs: number;
    allowed_roots: string[];
    default_write_mode: string;
  };
  runtime: Record<
    string,
    {
      path: string;
      exists: boolean;
      is_dir: boolean;
    }
  >;
}

export interface JobSnapshot {
  job_id: string;
  kind: string;
  project_root: string;
  args: Record<string, unknown>;
  status: "queued" | "running" | "finished" | "failed" | "cancelled";
  logs: string[];
  result?: Record<string, unknown> | null;
  error?: string | null;
  created_at: number;
  updated_at: number;
}

export interface AstrBotWindow extends Window {
  AstrBotPluginPage?: AstrBotPluginPageBridge;
}

export function projectParamsFromSearch(search: string): ProjectRefParams | undefined {
  const params = new URLSearchParams(search);
  const projectParams: ProjectRefParams = {};
  for (const key of ["project_id", "project_name", "project_path", "project"] as const) {
    const value = params.get(key);
    if (value) projectParams[key] = value;
  }
  const legacyPath = params.get("path");
  if (legacyPath && !projectParams.project_path) {
    projectParams.project_path = legacyPath;
  }
  return hasProjectRef(projectParams) ? projectParams : undefined;
}

export function hasProjectRef(params: ProjectRefParams | undefined): boolean {
  return Boolean(
    params?.project_id ||
      params?.project_name ||
      params?.project_path ||
      params?.project,
  );
}

export function projectParamsFromProject(project: Pick<ProjectSummary, "project_id">): ProjectRefParams {
  return { project_id: project.project_id };
}

export function searchFromProjectParams(params: ProjectRefParams): string {
  const query = new URLSearchParams();
  for (const key of ["project_id", "project_name", "project_path", "project"] as const) {
    const value = params[key];
    if (value) query.set(key, value);
  }
  const search = query.toString();
  return search ? `?${search}` : "";
}

export function unwrapPluginPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (record.status === "error") {
    throw new Error(String(record.message || "Plugin request failed."));
  }
  if (record.status === "ok" && "data" in record) {
    return record.data;
  }
  if ("error" in record && typeof record.error === "string") {
    throw new Error(record.error);
  }
  return payload;
}

export function describeGraphLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/file not found/i.test(message) || /status code 404/i.test(message)) {
    return "This project has not generated a graph yet. Start an Understand Anything analysis or rerun the project from this workspace.";
  }
  if (/no understand anything projects are registered/i.test(message)) {
    return "No Understand Anything projects are registered. Add a project path below and start an analysis.";
  }
  if (/multiple understand anything projects are registered/i.test(message)) {
    return "Select a project from the workspace before opening the graph.";
  }
  return message;
}

export async function pluginGet<T>(
  bridge: AstrBotPluginPageBridge,
  endpoint: string,
  params?: ProjectRefParams | Record<string, unknown>,
): Promise<T> {
  await bridge.ready();
  return unwrapPluginPayload(
    await bridge.apiGet(endpoint, params ? { ...params } : undefined),
  ) as T;
}

export async function pluginPost<T>(
  bridge: AstrBotPluginPageBridge,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  await bridge.ready();
  if (!bridge.apiPost) {
    throw new Error("AstrBot Plugin Page POST bridge is unavailable.");
  }
  return unwrapPluginPayload(await bridge.apiPost(endpoint, body)) as T;
}
