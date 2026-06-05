export interface AstrBotPluginPageBridge {
  ready: () => Promise<unknown>;
  apiGet: (endpoint: string, params?: Record<string, unknown>) => Promise<unknown>;
  apiPost?: (endpoint: string, body?: Record<string, unknown>) => Promise<unknown>;
  getLocale?: () => string;
  getI18n?: () => Record<string, unknown>;
  t?: (key: string, fallback?: string) => string;
  onContext?: (handler: (context: Record<string, unknown>) => void) => () => void;
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
  view?: "domain" | "structural" | "knowledge";
}

export interface ProjectSummary {
  project_id: string;
  id?: string;
  name: string;
  aliases?: string[];
  path?: string;
  graph_root?: string;
  graphRoot?: string;
  source?: Record<string, unknown>;
  status?: "empty" | "cloning" | "analyzing" | "ready" | "stale" | "failed" | "deleting" | string;
  current_job_id?: string | null;
  currentJobId?: string | null;
  last_job_id?: string | null;
  lastJobId?: string | null;
  last_error?: string | null;
  lastError?: string | null;
  last_analyzed_at?: number | null;
  lastAnalyzedAt?: string | number | null;
  node_count?: number;
  nodeCount?: number;
  edge_count?: number;
  edgeCount?: number;
  auto_update?: boolean;
  autoUpdate?: boolean;
  graph_ready?: boolean;
  graphReady?: boolean;
  domain_graph_ready?: boolean;
  domainGraphReady?: boolean;
  current_job?: JobSnapshot | null;
  currentJob?: JobSnapshot | null;
  recent_job?: JobSnapshot | null;
  recentJob?: JobSnapshot | null;
  can_retry?: boolean;
  canRetry?: boolean;
}

export interface ProjectIgnorePayload {
  project: ProjectSummary;
  ignore_path: string;
  exists: boolean;
  content: string;
  summary?: JobConfirmationSummary;
}

export interface JobProgressStep {
  phase: string;
  label: string;
  status: "pending" | "active" | "complete" | "failed" | "cancelled" | string;
}

export interface JobProgress {
  phase: string;
  label: string;
  percent: number;
  steps: JobProgressStep[];
  updated_at: number;
}

export interface AstrBotComputerUseConfigStatus {
  id: string;
  name: string;
  is_default: boolean;
  runtime: string;
  enabled: boolean;
  require_admin: boolean;
  sandbox_booter: string;
  blocking_reason: string;
}

export interface AstrBotComputerUseStatus extends AstrBotComputerUseConfigStatus {
  configs?: AstrBotComputerUseConfigStatus[];
  default_config?: AstrBotComputerUseConfigStatus;
  enabled_count?: number;
  disabled_count?: number;
  all_enabled?: boolean;
  effective_config_id?: string;
  dashboard_effective_config_id?: string;
}

export interface RuntimePathState {
  path: string;
  exists: boolean;
  is_dir: boolean;
}

export interface RuntimeToolStatus {
  name: string;
  command: string;
  path: string;
  available: boolean;
  supported: boolean;
  version: string;
  source: "path" | "env" | string;
  min_major?: number | null;
  blocking_reason: string;
}

export interface RuntimeReadiness {
  local_analysis_ready: boolean;
  github_analysis_ready: boolean;
  repair_needed: boolean;
  repair_available: boolean;
  auto_repair_enabled: boolean;
  dependency_state: {
    node_modules: boolean;
    core_dist: boolean;
    assistant_dist: boolean;
    runtime_dist: boolean;
  };
  blocking_reasons: string[];
  repair_blocking_reasons: string[];
  github_blocking_reason: string;
}

export interface RuntimeStatus {
  understand_anything_root: RuntimePathState;
  runtime_dist: RuntimePathState;
  core_dist: RuntimePathState;
  assistant_dist: RuntimePathState;
  dashboard_dist: RuntimePathState;
  dashboard_page: RuntimePathState;
  node_modules: RuntimePathState;
  github_cache_root: RuntimePathState;
  github_artifact_root: RuntimePathState;
  tools: {
    node: RuntimeToolStatus;
    pnpm: RuntimeToolStatus;
    git: RuntimeToolStatus;
  };
  readiness: RuntimeReadiness;
}

export interface PluginStatus {
  plugin: {
    name: string;
    display_name: string;
  };
  astrbot: {
    computer_use: AstrBotComputerUseStatus;
  };
  config: {
    provider_configured: boolean;
    subagent_provider_configured: boolean;
    cleanup_github_cache_after_analysis: boolean;
    auto_build: boolean;
    auto_update_poll_interval: number;
    max_concurrent_jobs: number;
    max_parallel_file_agents: number;
    max_parallel_article_agents: number;
    default_write_mode: string;
  };
  github?: {
    proxy_presets: string[];
  };
  runtime: RuntimeStatus;
  subagents?: SubAgentSetupStatus;
  subagent_provider_options?: SubAgentProviderOptions;
}

export interface SubAgentRoleStatus {
  role: string;
  agent_name: string;
  persona_id: string;
  handoff_name: string;
  status: "registered" | "missing" | "stale";
  registered: boolean;
  persona_registered: boolean;
  persona_stale_reasons: string[];
  loaded: boolean;
  stale_reasons: string[];
}

export interface SubAgentSetupStatus {
  ready: boolean;
  roles: SubAgentRoleStatus[];
  missing_roles: string[];
  stale_roles: string[];
  unloaded_roles: string[];
  registered_count: number;
  required_count: number;
  provider_override_configured: boolean;
  persona_folder_name?: string;
  persona_folder_id?: string | null;
  main_enable: boolean;
  remove_main_duplicate_tools: boolean;
  error?: string;
  upserted_count?: number;
  persona_upserted_count?: number;
  preserved_count?: number;
}

export interface ProviderSummary {
  id: string;
  model?: string;
  type?: string;
  provider_type?: string;
  enable?: boolean;
  model_metadata?: {
    modalities?: {
      input?: string[];
      output?: string[];
    };
    tool_call?: boolean;
    reasoning?: boolean;
    limit?: {
      context?: number;
      output?: number;
    };
  } & Record<string, unknown>;
}

export interface SubAgentProviderOptions {
  providers: ProviderSummary[];
  recommended_provider_id?: string;
}

export interface JobSnapshot {
  job_id: string;
  id?: string;
  kind: string;
  project_root: string;
  projectRoot?: string;
  args: Record<string, unknown>;
  status:
    | "queued"
    | "running"
    | "waiting_confirmation"
    | "finished"
    | "failed"
    | "cancelled";
  logs: string[];
  recentLogs?: string[];
  progress?: JobProgress;
  confirmation?: JobConfirmation | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  observations?: JobObservation[];
  terminal?: boolean;
  stage?: string;
  phase?: string;
  phase_label?: string;
  phaseLabel?: string;
  percent?: number;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number;
  can_retry?: boolean;
  canRetry?: boolean;
  summary?: string | null;
  created_at: number;
  updated_at: number;
}

export type JobObservationKind =
  | "system"
  | "stage"
  | "command"
  | "assistant"
  | "validation"
  | "quality"
  | "artifact"
  | "warning"
  | "error"
  | string;

export type JobObservationLevel = "info" | "success" | "warning" | "error";

export interface JobObservation {
  id: string;
  timestamp?: number;
  createdAt?: string;
  kind: JobObservationKind;
  level: JobObservationLevel;
  title: string;
  message: string;
  stage?: string;
  status?: string;
  details?: Record<string, unknown>;
}

export interface JobConfirmationSummary {
  generated?: boolean;
  gitignore_patterns?: string[];
  detected_dirs?: string[];
  test_file_patterns?: string[];
  [key: string]: unknown;
}

export interface JobConfirmation {
  kind: "understandignore" | string;
  project_root: string;
  graph_root: string;
  ignore_path: string;
  content: string;
  summary?: JobConfirmationSummary;
  instructions?: string;
  expires_at?: number;
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
  const view = params.get("view");
  if (view === "domain" || view === "structural" || view === "knowledge") {
    projectParams.view = view;
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

export function isComputerUseReady(
  status: AstrBotComputerUseStatus | null | undefined,
): boolean {
  return Boolean(status?.default_config?.enabled ?? status?.enabled);
}

export function disabledComputerUseConfigs(
  status: AstrBotComputerUseStatus | null | undefined,
): AstrBotComputerUseConfigStatus[] {
  if (!status) return [];
  if (status.configs?.length) {
    return status.configs.filter((config) => !config.enabled);
  }
  return status.enabled ? [] : [status];
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
  if (params.view) query.set("view", params.view);
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

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "error", "detail"] as const) {
      if (record[key]) return errorMessage(record[key]);
    }
    try {
      return JSON.stringify(record);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export function isPluginRouteMissingError(error: unknown): boolean {
  return /未找到该路由|route not found|plugin api route not found/i.test(
    errorMessage(error),
  );
}

export function describePluginRouteError(endpoint: string, error: unknown): string {
  if (!isPluginRouteMissingError(error)) {
    return errorMessage(error);
  }
  return `Plugin API route "${endpoint}" is not registered. Reload astrbot_plugin_UnderstandAnything in AstrBot, then reopen this dashboard.`;
}

export function describeGraphLoadError(
  error: unknown,
  t?: (key: string, fallback: string) => string,
): string {
  const message = errorMessage(error);
  if (/file not found/i.test(message) || /status code 404/i.test(message)) {
    return t
      ? t(
          "app.graphMissing",
          "This project has not generated a graph yet. Start an Understand Anything analysis or rerun the project from this workspace.",
        )
      : "This project has not generated a graph yet. Start an Understand Anything analysis or rerun the project from this workspace.";
  }
  if (/no understand anything projects are registered/i.test(message)) {
    return t
      ? t(
          "app.noProjectsRegistered",
          "No Understand Anything projects are registered. Add a project path below and start an analysis.",
        )
      : "No Understand Anything projects are registered. Add a project path below and start an analysis.";
  }
  if (/multiple understand anything projects are registered/i.test(message)) {
    return t
      ? t(
          "app.multipleProjectsRegistered",
          "Select a project from the workspace before opening the graph.",
        )
      : "Select a project from the workspace before opening the graph.";
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

export async function pluginGetOptional<T>(
  bridge: AstrBotPluginPageBridge,
  endpoint: string,
  params?: ProjectRefParams | Record<string, unknown>,
): Promise<T | null> {
  try {
    return await pluginGet<T>(bridge, endpoint, params);
  } catch (error) {
    if (isPluginRouteMissingError(error)) {
      return null;
    }
    throw error;
  }
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
  const locale = bridge.getLocale?.();
  const payload =
    locale && (!body || typeof body.locale !== "string" || !body.locale.trim())
      ? { ...(body || {}), locale }
      : body;
  return unwrapPluginPayload(await bridge.apiPost(endpoint, payload)) as T;
}
