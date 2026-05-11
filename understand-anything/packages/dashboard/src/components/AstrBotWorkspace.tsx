import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import {
  type AstrBotPluginPageBridge,
  type JobSnapshot,
  type PluginStatus,
  type ProjectRefParams,
  type ProjectSummary,
  type ProviderSummary,
  type SubAgentProviderOptions,
  type SubAgentSetupStatus,
  pluginGet,
  pluginPost,
  projectParamsFromProject,
} from "../utils/astrbotBridge";
import {
  buildAnalysisJobPayload,
  looksLikeGitHubTarget,
} from "../utils/analysisRequest";
import { getStorageItem, removeStorageItem, setStorageItem } from "../utils/safeBrowser";

interface AstrBotWorkspaceProps {
  bridge: AstrBotPluginPageBridge;
  onOpenProject: (params: ProjectRefParams) => void;
}

type LoadState = "loading" | "ready" | "error";

function isJobSnapshot(value: unknown): value is JobSnapshot {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as JobSnapshot).job_id === "string" &&
      typeof (value as JobSnapshot).status === "string",
  );
}

function formatDate(timestamp: number | null | undefined, emptyLabel: string): string {
  if (!timestamp) return emptyLabel;
  return new Date(timestamp * 1000).toLocaleString();
}

function githubAlias(project: ProjectSummary): string | null {
  return (
    project.aliases?.find(
      (alias) =>
        alias.includes("/") &&
        !alias.startsWith("http") &&
        !alias.includes("\\") &&
        !alias.includes(":"),
    ) ?? null
  );
}

function readSubAgentGuideDismissed(): boolean {
  return getStorageItem("local", "ua-subagent-guide-dismissed") === "true";
}

function providerIdentity(provider: ProviderSummary): string {
  return provider.model ? `${provider.id} · ${provider.model}` : provider.id;
}

function providerTypeLabel(provider: ProviderSummary): string {
  return provider.type || provider.provider_type || "chat_completion";
}

function providerCapabilities(
  provider: ProviderSummary,
  t: (key: string, fallback: string) => string,
): string[] {
  const input = provider.model_metadata?.modalities?.input ?? [];
  const capabilities: string[] = [];
  if (input.includes("image")) {
    capabilities.push(t("subagents.providerCapabilityImage", "Image"));
  }
  if (input.includes("audio")) {
    capabilities.push(t("subagents.providerCapabilityAudio", "Audio"));
  }
  if (provider.model_metadata?.tool_call) {
    capabilities.push(t("subagents.providerCapabilityTools", "Tools"));
  }
  if (provider.model_metadata?.reasoning) {
    capabilities.push(t("subagents.providerCapabilityReasoning", "Reasoning"));
  }
  return capabilities;
}

export default function AstrBotWorkspace({
  bridge,
  onOpenProject,
}: AstrBotWorkspaceProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [subagents, setSubagents] = useState<SubAgentSetupStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [projectTarget, setProjectTarget] = useState("");
  const [fullAnalysis, setFullAnalysis] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [starting, setStarting] = useState(false);
  const [registeringSubagents, setRegisteringSubagents] = useState(false);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerSearch, setProviderSearch] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [subagentGuideDismissed, setSubagentGuideDismissed] = useState(
    readSubAgentGuideDismissed,
  );
  const [currentJob, setCurrentJob] = useState<JobSnapshot | null>(null);
  const [openedFinishedJobId, setOpenedFinishedJobId] = useState<string | null>(
    null,
  );
  const currentJobId = currentJob?.job_id;
  const currentJobStatus = currentJob?.status;

  const loadWorkspace = useCallback(async () => {
    setLoadState("loading");
    setError(null);
    try {
      const [nextStatus, projectPayload, subagentPayload] = await Promise.all([
        pluginGet<PluginStatus>(bridge, "status"),
        pluginGet<{ projects: ProjectSummary[] }>(bridge, "projects"),
        pluginGet<SubAgentSetupStatus>(bridge, "subagents/status"),
      ]);
      setStatus(nextStatus);
      setSubagents(subagentPayload);
      setProjects(projectPayload.projects);
      setLoadState("ready");
    } catch (loadError) {
      setLoadState("error");
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [bridge]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    if (
      !currentJobId ||
      !currentJobStatus ||
      currentJobStatus === "finished" ||
      currentJobStatus === "failed" ||
      currentJobStatus === "cancelled"
    ) {
      return;
    }
    let cancelled = false;
    let intervalId: number | undefined;
    let subscriptionId: string | null = null;

    const updateJob = (value: unknown) => {
      if (!cancelled && isJobSnapshot(value)) {
        setCurrentJob(value);
      }
    };

    if (bridge.subscribeSSE) {
      bridge
        .subscribeSSE(
          `jobs/${currentJobId}/events`,
          {
            onMessage: (event) => updateJob(event.parsed),
            onError: () => {
              if (!cancelled) setError(t("workspace.jobEventInterrupted", "Job event stream interrupted."));
            },
          },
        )
        .then((id) => {
          subscriptionId = id;
        })
        .catch((subscribeError) => {
          if (!cancelled) {
            setError(
              subscribeError instanceof Error
                ? subscribeError.message
                : String(subscribeError),
            );
          }
        });
    } else {
      intervalId = window.setInterval(() => {
        void pluginGet<JobSnapshot>(bridge, `jobs/${currentJobId}`)
          .then(updateJob)
          .catch(() => {});
      }, 1500);
    }

    return () => {
      cancelled = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
      if (subscriptionId && bridge.unsubscribeSSE) {
        void bridge.unsubscribeSSE(subscriptionId);
      }
    };
  }, [bridge, currentJobId, currentJobStatus, t]);

  useEffect(() => {
    if (currentJob?.status !== "finished") return;
    if (openedFinishedJobId === currentJob.job_id) return;
    setOpenedFinishedJobId(currentJob.job_id);
    void loadWorkspace();
    const projectId =
      typeof currentJob.args.project_id === "string" ? currentJob.args.project_id : "";
    onOpenProject(projectId ? { project_id: projectId } : { project_path: currentJob.project_root });
  }, [currentJob, loadWorkspace, onOpenProject, openedFinishedJobId]);

  const runtimeItems = useMemo(() => {
    if (!status) return [];
    return [
      ["runtimeItems.runtimeDist", "Runtime dist", status.runtime.runtime_dist?.exists],
      ["runtimeItems.coreDist", "Core dist", status.runtime.core_dist?.exists],
      ["runtimeItems.dashboardDist", "Dashboard dist", status.runtime.dashboard_dist?.exists],
      ["runtimeItems.dashboardPage", "Dashboard page", status.runtime.dashboard_page?.exists],
      ["runtimeItems.nodeModules", "Node modules", status.runtime.node_modules?.exists],
      ["runtimeItems.githubCacheRoot", "GitHub cache", status.runtime.github_cache_root?.exists],
      ["runtimeItems.githubArtifactRoot", "GitHub artifacts", status.runtime.github_artifact_root?.exists],
    ] as const;
  }, [status]);

  const subagentsReady = Boolean(subagents?.ready);
  const showSubagentGuide = Boolean(
    subagents && (!subagents.ready || !subagentGuideDismissed),
  );
  const blockedRoles = useMemo(() => {
    if (!subagents) return [];
    return Array.from(
      new Set([
        ...subagents.missing_roles,
        ...subagents.stale_roles,
        ...subagents.unloaded_roles,
      ]),
    );
  }, [subagents]);
  const filteredProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    if (!query) return providers;
    return providers.filter((provider) =>
      [
        provider.id,
        provider.model,
        provider.type,
        provider.provider_type,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [providerSearch, providers]);

  const dismissSubagentGuide = () => {
    setSubagentGuideDismissed(true);
    setStorageItem("local", "ua-subagent-guide-dismissed", "true");
  };

  const applyProviderOptions = (payload: SubAgentProviderOptions) => {
    const nextProviders = payload.providers ?? [];
    setProviders(nextProviders);
    setSelectedProviderId(
      payload.recommended_provider_id || nextProviders[0]?.id || "",
    );
  };

  const openSubagentProviderDialog = async () => {
    setProviderDialogOpen(true);
    setProviderSearch("");
    setProviderError(null);
    setProvidersLoading(true);
    try {
      const nextStatus = await pluginGet<PluginStatus>(bridge, "status");
      setStatus(nextStatus);
      if (nextStatus.subagents) {
        setSubagents(nextStatus.subagents);
      }
      if (nextStatus.subagent_provider_options) {
        applyProviderOptions(nextStatus.subagent_provider_options);
        return;
      }
      const payload = await pluginGet<SubAgentProviderOptions>(bridge, "subagents/providers");
      applyProviderOptions(payload);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setProviderError(
        /未找到该路由|route not found|not found/i.test(message)
          ? t(
              "subagents.providerRouteUnavailable",
              "Provider selector API is unavailable. Reload this plugin in AstrBot, then reopen the dashboard.",
            )
          : message,
      );
      setProviders([]);
      setSelectedProviderId("");
    } finally {
      setProvidersLoading(false);
    }
  };

  const registerSubagents = async () => {
    setRegisteringSubagents(true);
    setError(null);
    try {
      const nextStatus = await pluginPost<SubAgentSetupStatus>(
        bridge,
        "subagents/register",
        { provider_id: selectedProviderId },
      );
      setSubagents(nextStatus);
      setStatus((current) =>
        current ? { ...current, subagents: nextStatus } : current,
      );
      setSubagentGuideDismissed(false);
      setProviderDialogOpen(false);
      removeStorageItem("local", "ua-subagent-guide-dismissed");
    } catch (registerError) {
      setError(
        registerError instanceof Error
          ? registerError.message
          : String(registerError),
      );
    } finally {
      setRegisteringSubagents(false);
    }
  };

  const startAnalysis = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedTarget = projectTarget.trim();
    if (!trimmedTarget) {
      setError(t("workspace.projectTargetRequired", "Project target is required."));
      return;
    }
    if (!subagentsReady) {
      setError(t("workspace.subagentsRequired", "Register UA SubAgents before starting analysis."));
      return;
    }
    if (looksLikeGitHubTarget(trimmedTarget) && status?.config.git_available === false) {
      setError(t("workspace.gitUnavailable", "Git is unavailable on this AstrBot host."));
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const job = await pluginPost<JobSnapshot>(
        bridge,
        "jobs/start",
        buildAnalysisJobPayload({
          target: trimmedTarget,
          fullAnalysis,
          autoUpdate,
        }),
      );
      setCurrentJob(job);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setStarting(false);
    }
  };
  const analysisTargetReady = Boolean(projectTarget.trim());
  const gitReady =
    !looksLikeGitHubTarget(projectTarget) || status?.config.git_available !== false;

  return (
    <div className="h-screen w-screen bg-root text-text-primary noise-overlay overflow-auto">
      <div className="mx-auto max-w-[1120px] px-4 py-5 sm:px-6 sm:py-7">
        <header className="mb-6 flex flex-col gap-3 border-b border-border-subtle pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-heading text-2xl text-text-primary">
              Understand Anything
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {t("workspace.subtitle", "Plugin workspace")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadWorkspace()}
              className="rounded-md border border-border-medium bg-elevated px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              {t("common.refresh", "Refresh")}
            </button>
            <a
              href="/#/extension/astrbot_plugin_UnderstandAnything"
              target="_top"
              className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-root transition-all hover:brightness-110"
            >
              {t("common.pluginSettings", "Plugin Settings")}
            </a>
          </div>
        </header>

        {error && (
          <div className="mb-5 rounded-md border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {showSubagentGuide && subagents && (
          <section className="mb-6 rounded-lg border border-accent/40 bg-surface p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-heading text-lg text-text-primary">
                    {t("subagents.title", "UA SubAgents")}
                  </h2>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      subagents.ready
                        ? "bg-green-400/10 text-green-400"
                        : "bg-amber-400/10 text-amber-400"
                    }`}
                  >
                    {subagents.ready
                      ? t("common.ready", "Ready")
                      : t("subagents.registrationRequired", "Registration required")}
                  </span>
                </div>
                <p className="mt-2 max-w-3xl text-sm text-text-secondary">
                  {t(
                    "subagents.description",
                    "Understand Anything uses persistent AstrBot SubAgents for worker batches. Register the UA roles once, then analysis jobs can dispatch real parallel agents.",
                  )}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {blockedRoles.length === 0 ? (
                    <span className="rounded-md bg-green-400/10 px-2.5 py-1 text-xs font-semibold text-green-400">
                      {t("subagents.allRegistered", "All roles registered")}
                    </span>
                  ) : (
                    blockedRoles.map((role) => (
                      <span
                        key={role}
                        className="rounded-md bg-root px-2.5 py-1 font-mono text-xs text-amber-300"
                      >
                        {role}
                      </span>
                    ))
                  )}
                </div>
                {status && (
                  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                    <span>
                      {t("subagents.fileAgents", "File agents")} {status.config.max_parallel_file_agents} / {t("subagents.articleAgents", "Article agents")} {status.config.max_parallel_article_agents}
                    </span>
                    {subagents.persona_folder_name && (
                      <span>
                        {t("subagents.personaFolder", "Persona folder")} {subagents.persona_folder_name}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void openSubagentProviderDialog()}
                  disabled={registeringSubagents}
                  className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-root transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {registeringSubagents
                    ? t("subagents.registeringButton", "Registering UA SubAgents")
                    : t("subagents.registerButton", "Register UA SubAgents")}
                </button>
                <button
                  type="button"
                  onClick={dismissSubagentGuide}
                  className="rounded-md border border-border-medium bg-elevated px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
                >
                  {t("common.dismiss", "Dismiss")}
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="mb-6 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-lg border border-border-subtle bg-surface p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-heading text-lg text-text-primary">
                  {t("workspace.initialConfiguration", "Initial Configuration")}
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  {t("workspace.configManaged", "Configuration is managed from AstrBot plugin settings.")}
                </p>
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                  loadState === "ready"
                    ? "bg-green-400/10 text-green-400"
                    : "bg-amber-400/10 text-amber-400"
                }`}
              >
                {loadState === "loading"
                  ? t("common.loading", "Loading")
                  : loadState === "ready"
                    ? t("common.ready", "Ready")
                    : t("common.error", "Error")}
              </span>
            </div>

            {status && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md bg-elevated p-3">
                  <div className="text-[11px] uppercase tracking-wider text-text-muted">
                    {t("workspace.llmProvider", "LLM Provider")}
                  </div>
                  <div className="mt-1 text-sm text-text-primary">
                    {status.config.provider_configured
                      ? t("common.configured", "Configured")
                      : t("common.currentSessionProvider", "Current session provider")}
                  </div>
                </div>
                <div className="rounded-md bg-elevated p-3">
                  <div className="text-[11px] uppercase tracking-wider text-text-muted">
                    {t("workspace.nodeRuntime", "Node Runtime")}
                  </div>
                  <div className="mt-1 text-sm text-text-primary">
                    {status.config.node_bin} / {status.config.pnpm_bin}
                  </div>
                </div>
                <div className="rounded-md bg-elevated p-3 sm:col-span-2">
                  <div className="text-[11px] uppercase tracking-wider text-text-muted">
                    {t("workspace.gitRuntime", "Git Runtime")}
                  </div>
                  <div className="mt-1 text-sm text-text-primary">
                    {status.config.git_bin} · {status.config.git_available
                      ? t("common.ready", "Ready")
                      : t("common.missing", "Missing")}
                  </div>
                  {status.config.github_cache_root && (
                    <div
                      className="mt-1 truncate font-mono text-xs text-text-muted"
                      title={status.config.github_cache_root}
                    >
                      {status.config.github_cache_root}
                    </div>
                  )}
                  {status.config.github_artifact_root && (
                    <div
                      className="mt-1 truncate font-mono text-xs text-text-muted"
                      title={status.config.github_artifact_root}
                    >
                      {status.config.github_artifact_root}
                    </div>
                  )}
                </div>
                <div className="rounded-md bg-elevated p-3 sm:col-span-2">
                  <div className="text-[11px] uppercase tracking-wider text-text-muted">
                    {t("workspace.allowedRoots", "Allowed Roots")}
                  </div>
                  <div className="mt-2 space-y-1">
                    {status.config.allowed_roots.map((root) => (
                      <div
                        key={root}
                        className="truncate font-mono text-xs text-text-secondary"
                        title={root}
                      >
                        {root}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border-subtle bg-surface p-4">
            <h2 className="font-heading text-lg text-text-primary">{t("common.runtime", "Runtime")}</h2>
            <div className="mt-4 space-y-2">
              {runtimeItems.map(([key, fallback, exists]) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-md bg-elevated px-3 py-2"
                >
                  <span className="text-sm text-text-secondary">{t(key, fallback)}</span>
                  <span
                    className={`text-xs font-semibold ${
                      exists ? "text-green-400" : "text-amber-400"
                    }`}
                  >
                    {Boolean(exists) ? t("common.ready", "Ready") : t("common.missing", "Missing")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-lg border border-border-subtle bg-surface p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-heading text-lg text-text-primary">{t("common.projects", "Projects")}</h2>
              <span className="text-xs uppercase tracking-wider text-text-muted">
                {t("workspace.registeredProjects", "{count} registered", { count: projects.length })}
              </span>
            </div>

            {projects.length === 0 ? (
              <div className="rounded-md border border-border-subtle bg-elevated p-4 text-sm text-text-secondary">
                {t("workspace.noProjects", "No registered projects yet.")}
              </div>
            ) : (
              <div className="space-y-2">
                {projects.map((project) => (
                  <button
                    type="button"
                    key={project.project_id}
                    onClick={() => onOpenProject(projectParamsFromProject(project))}
                    className="w-full rounded-md border border-border-subtle bg-elevated p-3 text-left transition-colors hover:border-border-medium hover:bg-accent/10"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-text-primary">
                          {project.name}
                        </div>
                        {githubAlias(project) && (
                          <div className="mt-1 truncate text-xs font-semibold text-accent">
                            {githubAlias(project)}
                          </div>
                        )}
                        <div className="mt-1 truncate font-mono text-xs text-text-muted">
                          {project.path}
                        </div>
                        {project.graph_root && project.graph_root !== project.path && (
                          <div
                            className="mt-1 truncate font-mono text-xs text-text-muted"
                            title={project.graph_root}
                          >
                            {project.graph_root}
                          </div>
                        )}
                      </div>
                      <span className="shrink-0 rounded-full bg-accent/10 px-2 py-1 text-[11px] font-semibold text-accent">
                        {t("common.open", "Open")}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-text-muted">
                      {formatDate(project.last_analyzed_at, t("workspace.notAnalyzed", "Not analyzed"))}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border-subtle bg-surface p-4">
            <h2 className="font-heading text-lg text-text-primary">{t("workspace.analyzeProject", "Analyze Project")}</h2>
            <form onSubmit={startAnalysis} className="mt-4 space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-wider text-text-muted">
                  {t("workspace.projectTarget", "Project Target")}
                </span>
                <input
                  type="text"
                  value={projectTarget}
                  onChange={(event) => setProjectTarget(event.target.value)}
                  placeholder={t(
                    "workspace.projectTargetPlaceholder",
                    "https://github.com/owner/repo/tree/main/packages/app or D:\\path\\to\\project",
                  )}
                  className="w-full rounded-md border border-border-subtle bg-elevated px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none"
                />
              </label>

              <div className="flex flex-wrap gap-3">
                <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={fullAnalysis}
                    onChange={(event) => setFullAnalysis(event.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  {t("workspace.fullAnalysis", "Full analysis")}
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={autoUpdate}
                    onChange={(event) => setAutoUpdate(event.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  {t("workspace.autoUpdate", "Auto update")}
                </label>
              </div>

              <button
                type="submit"
                disabled={starting || !analysisTargetReady || !subagentsReady || !gitReady}
                className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-root transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {starting
                  ? t("workspace.starting", "Starting")
                  : t("workspace.startAnalysis", "Start Analysis")}
              </button>
              {!subagentsReady && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                  {t("workspace.subagentsBlocked", "Register UA SubAgents from this panel before starting analysis jobs.")}
                </div>
              )}
              {!gitReady && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                  {t("workspace.gitUnavailable", "Git is unavailable on this AstrBot host.")}
                </div>
              )}
            </form>

            {currentJob && (
              <div className="mt-4 rounded-md border border-border-subtle bg-elevated p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-text-primary">
                    {currentJob.kind}
                  </div>
                  <span className="rounded-full bg-root px-2 py-1 text-xs font-semibold text-accent">
                    {currentJob.status}
                  </span>
                </div>
                <div className="mt-2 truncate font-mono text-xs text-text-muted">
                  {currentJob.project_root}
                </div>
                {currentJob.error && (
                  <div className="mt-2 text-sm text-red-200">{currentJob.error}</div>
                )}
                {currentJob.logs.length > 0 && (
                  <div className="mt-3 max-h-[200px] overflow-auto rounded bg-root p-2 font-mono text-xs text-text-secondary">
                    {currentJob.logs.map((line, index) => (
                      <div key={`${line}-${index}`}>{line}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {providerDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6">
          <div className="w-full max-w-[640px] rounded-lg border border-border-subtle bg-surface shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-4 py-4">
              <div className="min-w-0">
                <h2 className="font-heading text-lg text-text-primary">
                  {t("subagents.providerDialogTitle", "Choose LLM Provider")}
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  {t(
                    "subagents.providerDialogDescription",
                    "The selected chat provider will be written to all UA SubAgents during registration.",
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setProviderDialogOpen(false)}
                className="rounded-md border border-border-medium bg-elevated px-2.5 py-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
              >
                {t("common.close", "Close")}
              </button>
            </div>

            <div className="space-y-3 px-4 py-4">
              <input
                type="search"
                value={providerSearch}
                onChange={(event) => setProviderSearch(event.target.value)}
                placeholder={t("subagents.providerSearch", "Search providers")}
                className="w-full rounded-md border border-border-subtle bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none"
              />

              {providersLoading && (
                <div className="rounded-md border border-border-subtle bg-elevated px-3 py-3 text-sm text-text-secondary">
                  {t("subagents.providerLoading", "Loading providers")}
                </div>
              )}

              {providerError && (
                <div className="rounded-md border border-red-700 bg-red-900/30 px-3 py-3 text-sm text-red-200">
                  {providerError}
                </div>
              )}

              {!providersLoading && providers.length > 0 && (
                <div className="max-h-[360px] space-y-2 overflow-auto pr-1">
                  <button
                    type="button"
                    onClick={() => setSelectedProviderId("")}
                    className={`w-full rounded-md border p-3 text-left transition-colors ${
                      selectedProviderId === ""
                        ? "border-accent bg-accent/10"
                        : "border-border-subtle bg-elevated hover:border-border-medium"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text-primary">
                          {t("subagents.providerDefaultTitle", "AstrBot default provider")}
                        </div>
                        <div className="mt-1 text-xs text-text-secondary">
                          {t(
                            "subagents.providerDefaultDescription",
                            "Use the current/default chat provider without storing a fixed provider id.",
                          )}
                        </div>
                      </div>
                      {selectedProviderId === "" && (
                        <span className="shrink-0 rounded-full bg-accent/15 px-2 py-1 text-[11px] font-semibold text-accent">
                          {t("common.selected", "Selected")}
                        </span>
                      )}
                    </div>
                  </button>

                  {filteredProviders.map((provider) => {
                    const disabled = provider.enable === false;
                    const capabilities = providerCapabilities(provider, t);
                    const selected = selectedProviderId === provider.id;
                    return (
                      <button
                        type="button"
                        key={provider.id}
                        onClick={() => {
                          if (!disabled) setSelectedProviderId(provider.id);
                        }}
                        disabled={disabled}
                        className={`w-full rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                          selected
                            ? "border-accent bg-accent/10"
                            : "border-border-subtle bg-elevated hover:border-border-medium"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-text-primary">
                              {providerIdentity(provider)}
                            </div>
                            <div className="mt-1 truncate text-xs text-text-secondary">
                              {providerTypeLabel(provider)}
                            </div>
                            {capabilities.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {capabilities.map((capability) => (
                                  <span
                                    key={`${provider.id}-${capability}`}
                                    className="rounded-full bg-root px-2 py-0.5 text-[11px] font-semibold text-text-muted"
                                  >
                                    {capability}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          {selected && (
                            <span className="shrink-0 rounded-full bg-accent/15 px-2 py-1 text-[11px] font-semibold text-accent">
                              {t("common.selected", "Selected")}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {!providersLoading && providers.length === 0 && !providerError && (
                <div className="rounded-md border border-border-subtle bg-elevated px-3 py-6 text-center text-sm text-text-secondary">
                  {t("subagents.providerNoProviders", "No chat providers are available.")}
                </div>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle px-4 py-4">
              <button
                type="button"
                onClick={() => setProviderDialogOpen(false)}
                className="rounded-md border border-border-medium bg-elevated px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
              >
                {t("common.cancel", "Cancel")}
              </button>
              <button
                type="button"
                onClick={() => void registerSubagents()}
                disabled={providersLoading || registeringSubagents || providers.length === 0}
                className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-root transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {registeringSubagents
                  ? t("subagents.registeringButton", "Registering UA SubAgents")
                  : t("subagents.registerWithProvider", "Register with provider")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
