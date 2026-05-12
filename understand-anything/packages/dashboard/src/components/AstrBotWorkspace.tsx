import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import {
  type AstrBotPluginPageBridge,
  type JobSnapshot,
  type PluginStatus,
  type ProjectRefParams,
  type ProjectSummary,
  type ProviderSummary,
  type RuntimeToolStatus,
  type SubAgentProviderOptions,
  type SubAgentSetupStatus,
  describePluginRouteError,
  disabledComputerUseConfigs,
  errorMessage,
  isComputerUseReady,
  isPluginRouteMissingError,
  pluginGet,
  pluginGetOptional,
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

function computerUseRuntimeName(
  runtime: string | undefined,
  t: (key: string, fallback: string) => string,
): string {
  if (runtime === "local") return t("workspace.computerUseLocal", "Local");
  if (runtime === "sandbox") return t("workspace.computerUseSandbox", "Sandbox");
  if (runtime && runtime !== "none") return runtime;
  return t("workspace.computerUseDisabled", "Disabled");
}

function runtimeToolDetail(
  tool: RuntimeToolStatus,
  label: string,
  t: (
    key: string,
    fallback: string,
    vars?: Record<string, string | number | boolean | null | undefined>,
  ) => string,
): string {
  if (!tool.available) {
    return t("workspace.runtimeToolMissing", "{tool} was not found in PATH.", {
      tool: label,
    });
  }
  if (!tool.supported && tool.min_major) {
    return t("workspace.runtimeToolUnsupported", "{tool} {version} is below {minimum}.", {
      tool: label,
      version: tool.version || tool.command,
      minimum: `${tool.min_major}+`,
    });
  }
  if (tool.version && tool.path) return `${tool.version} · ${tool.path}`;
  if (tool.version) return tool.version;
  if (tool.path) return tool.path;
  return tool.blocking_reason || tool.command;
}

function statusTone(ready: boolean): string {
  return ready
    ? "border-green-400/30 bg-green-400/10 text-green-300"
    : "border-amber-400/30 bg-amber-400/10 text-amber-300";
}

function StatusPill({
  ready,
  label,
}: {
  ready: boolean;
  label: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(ready)}`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${ready ? "bg-green-300" : "bg-amber-300"}`}
      />
      {label}
    </span>
  );
}

function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-border-subtle bg-surface shadow-[0_0_0_1px_rgba(255,255,255,0.02)] ${className}`}
    >
      {children}
    </section>
  );
}

function SetupRow({
  label,
  detail,
  ready,
  statusLabel,
  action,
}: {
  label: string;
  detail: ReactNode;
  ready: boolean;
  statusLabel: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-b border-border-subtle py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">{label}</div>
          <div className="mt-1 text-xs leading-relaxed text-text-muted">{detail}</div>
        </div>
        <StatusPill ready={ready} label={statusLabel} />
      </div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export default function AstrBotWorkspace({
  bridge,
  onOpenProject,
}: AstrBotWorkspaceProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [subagents, setSubagents] = useState<SubAgentSetupStatus | null>(null);
  const [subagentError, setSubagentError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [projectTarget, setProjectTarget] = useState("");
  const [fullAnalysis, setFullAnalysis] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [githubProxy, setGithubProxy] = useState("");
  const [starting, setStarting] = useState(false);
  const [repairingRuntime, setRepairingRuntime] = useState(false);
  const [runtimeRepairMessage, setRuntimeRepairMessage] = useState<string | null>(null);
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
  const computerUse = status?.astrbot?.computer_use;
  const defaultComputerUse = computerUse?.default_config ?? computerUse;
  const computerUseConfigs = computerUse?.configs?.length
    ? computerUse.configs
    : defaultComputerUse
      ? [defaultComputerUse]
      : [];
  const disabledComputerUse = disabledComputerUseConfigs(computerUse);
  const disabledSessionComputerUse = disabledComputerUse.filter(
    (config) => !config.is_default,
  );
  const computerUseReady = status ? isComputerUseReady(computerUse) : false;
  const runtimeReadiness = status?.runtime.readiness;
  const localRuntimeReady = runtimeReadiness?.local_analysis_ready ?? false;

  const loadWorkspace = useCallback(async () => {
    setLoadState("loading");
    setError(null);
    setSubagentError(null);
    try {
      const [nextStatus, projectPayload] = await Promise.all([
        pluginGet<PluginStatus>(bridge, "status"),
        pluginGet<{ projects: ProjectSummary[] }>(bridge, "projects"),
      ]);
      setStatus(nextStatus);
      setProjects(projectPayload.projects);

      try {
        const subagentPayload = await pluginGetOptional<SubAgentSetupStatus>(
          bridge,
          "subagents/status",
        );
        setSubagents(subagentPayload);
        if (!subagentPayload) {
          setSubagentError(
            describePluginRouteError("subagents/status", new Error("未找到该路由")),
          );
        }
      } catch (subagentLoadError) {
        setSubagents(null);
        setSubagentError(
          subagentLoadError instanceof Error
            ? subagentLoadError.message
            : String(subagentLoadError),
        );
      }

      setLoadState("ready");
    } catch (loadError) {
      setLoadState("error");
      setError(
        isPluginRouteMissingError(loadError)
          ? describePluginRouteError("status/projects", loadError)
          : errorMessage(loadError),
      );
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
  const runtimeToolItems = useMemo(() => {
    if (!status) return [];
    return [
      { key: "node", label: "Node.js", tool: status.runtime.tools.node },
      { key: "pnpm", label: "pnpm", tool: status.runtime.tools.pnpm },
      { key: "git", label: "Git", tool: status.runtime.tools.git },
    ];
  }, [status]);
  const githubProxyPresets = status?.github?.proxy_presets ?? [];

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
      setProviderError(
        isPluginRouteMissingError(loadError)
          ? describePluginRouteError("subagents/providers", loadError)
          : errorMessage(loadError),
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

  const repairRuntime = async () => {
    setRepairingRuntime(true);
    setError(null);
    setRuntimeRepairMessage(null);
    try {
      const result = await pluginPost<{ actions?: string[]; ready?: boolean }>(
        bridge,
        "runtime/repair",
      );
      const actions = result.actions ?? [];
      setRuntimeRepairMessage(
        actions.length > 0
          ? t("workspace.runtimeRepairSucceeded", "Runtime repair completed.")
          : t("workspace.runtimeAlreadyReady", "Runtime dependencies are already ready."),
      );
      await loadWorkspace();
    } catch (repairError) {
      setError(errorMessage(repairError));
    } finally {
      setRepairingRuntime(false);
    }
  };

  const startAnalysis = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedTarget = projectTarget.trim();
    if (!trimmedTarget) {
      setError(t("workspace.projectTargetRequired", "Project target is required."));
      return;
    }
    if (subagentError) {
      setError(subagentError);
      return;
    }
    if (!subagentsReady) {
      setError(t("workspace.subagentsRequired", "Register UA SubAgents before starting analysis."));
      return;
    }
    if (!computerUseReady) {
      setError(
        t(
          "workspace.computerUseRequired",
          "Enable Computer Use runtime before starting analysis.",
        ),
      );
      return;
    }
    if (!localRuntimeReady) {
      const reason =
        runtimeReadiness?.blocking_reasons?.join(" ") ||
        t("workspace.runtimeUnavailable", "Understand Anything runtime is not ready.");
      setError(reason);
      return;
    }
    if (looksLikeGitHubTarget(trimmedTarget) && !runtimeReadiness?.github_analysis_ready) {
      setError(
        runtimeReadiness?.github_blocking_reason ||
          t("workspace.gitUnavailable", "Git is unavailable on this AstrBot host."),
      );
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
          githubProxy,
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
  const analyzingGithubTarget = looksLikeGitHubTarget(projectTarget);
  const gitReady =
    !analyzingGithubTarget ||
    runtimeReadiness?.github_analysis_ready !== false;
  const computerUseRuntimeLabel = (() => {
    if (!defaultComputerUse) return t("common.loading", "Loading");
    return computerUseRuntimeName(defaultComputerUse.runtime, t);
  })();
  const setupReadyCount = [computerUseReady, localRuntimeReady, subagentsReady].filter(Boolean).length;
  const setupTotal = 3;
  const setupComplete = setupReadyCount === setupTotal;
  const setupProgressLabel = t("workspace.setupProgress", "{ready}/{total} ready", {
    ready: setupReadyCount,
    total: setupTotal,
  });
  const dashboardConfigName = defaultComputerUse?.name || t("common.default", "Default");
  const canStartAnalysis =
    !starting &&
    analysisTargetReady &&
    !subagentError &&
    subagentsReady &&
    computerUseReady &&
    localRuntimeReady &&
    gitReady;

  return (
    <div className="min-h-screen w-screen bg-root text-text-primary noise-overlay overflow-auto">
      <div className="mx-auto max-w-[1280px] px-4 py-5 sm:px-6 sm:py-7">
        <header className="mb-5 border-b border-border-subtle pb-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <h1 className="font-heading text-2xl text-text-primary">
                Understand Anything
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">
                {t("workspace.subtitle", "Plugin workspace")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill
                ready={setupComplete}
                label={setupComplete ? t("common.ready", "Ready") : setupProgressLabel}
              />
              <span className="rounded-full border border-border-subtle bg-elevated px-2.5 py-1 text-xs font-semibold text-text-secondary">
                {t("workspace.registeredProjects", "{count} registered", { count: projects.length })}
              </span>
              <button
                type="button"
                onClick={() => void loadWorkspace()}
                className="rounded-md border border-border-medium bg-elevated px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t("common.refresh", "Refresh")}
              </button>
            </div>
          </div>
        </header>

        {error && (
          <div className="mb-5 rounded-md border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {loadState === "loading" && (
          <Panel className="p-5">
            <div className="text-sm text-text-secondary">{t("common.loading", "Loading")}</div>
          </Panel>
        )}

        {status && (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
            <main className="space-y-5">
              <Panel className="p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="font-heading text-xl text-text-primary">
                      {t("workspace.analyzeProject", "Analyze Project")}
                    </h2>
                    <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
                      {t(
                        "workspace.analyzeProjectDescription",
                        "Start with a local project directory or GitHub repository URL. Finished jobs open directly into the graph view.",
                      )}
                    </p>
                  </div>
                  <StatusPill
                    ready={canStartAnalysis}
                    label={canStartAnalysis ? t("common.ready", "Ready") : t("workspace.setupRequired", "Setup required")}
                  />
                </div>

                <form onSubmit={startAnalysis} className="mt-5 space-y-4">
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
                      className="w-full rounded-md border border-border-subtle bg-elevated px-3 py-2.5 font-mono text-sm text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    />
                  </label>

                  {analyzingGithubTarget && (
                    <label className="block">
                      <span className="mb-1 block text-xs uppercase tracking-wider text-text-muted">
                        {t("workspace.githubProxy", "Git clone proxy")}
                      </span>
                      <select
                        value={githubProxy}
                        onChange={(event) => setGithubProxy(event.target.value)}
                        className="w-full rounded-md border border-border-subtle bg-elevated px-3 py-2.5 text-sm text-text-primary focus:border-accent focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        <option value="">
                          {t("workspace.githubProxyDirect", "Direct GitHub")}
                        </option>
                        {githubProxyPresets.map((proxy) => (
                          <option key={proxy} value={proxy}>
                            {proxy}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs leading-relaxed text-text-muted">
                        {t(
                          "workspace.githubProxyDescription",
                          "Uses AstrBot's bundled GitHub proxy presets for git clone and fetch.",
                        )}
                      </p>
                    </label>
                  )}

                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
                      disabled={!canStartAnalysis}
                      className="rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-root transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {starting
                        ? t("workspace.starting", "Starting")
                        : t("workspace.startAnalysis", "Start Analysis")}
                    </button>
                  </div>
                </form>

                <div className="mt-4 grid gap-2 md:grid-cols-2">
                  {!subagentsReady && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                      {subagentError ||
                        t("workspace.subagentsBlocked", "Register UA SubAgents from this panel before starting analysis jobs.")}
                    </div>
                  )}
                  {!computerUseReady && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                      <div>
                        {t(
                          "workspace.computerUseBlocked",
                          "Enable Computer Use runtime before starting analysis jobs.",
                        )}
                      </div>
                      <div className="mt-1 text-xs text-amber-100/80">
                        {t("workspace.computerUseSetupPath", "Config -> General -> Computer Use -> Runtime")} ·{" "}
                        {t("workspace.computerUseSetupValue", "local or sandbox")}
                      </div>
                    </div>
                  )}
                  {!localRuntimeReady && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                      <div>
                        {t(
                          "workspace.runtimeBlocked",
                          "Understand Anything runtime must be ready before starting analysis jobs.",
                        )}
                      </div>
                      {runtimeReadiness?.blocking_reasons?.length ? (
                        <div className="mt-1 text-xs text-amber-100/80">
                          {runtimeReadiness.blocking_reasons.join(" ")}
                        </div>
                      ) : null}
                    </div>
                  )}
                  {!gitReady && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                      {t("workspace.gitUnavailable", "Git is unavailable on this AstrBot host.")}
                    </div>
                  )}
                </div>
              </Panel>

              {currentJob && (
                <Panel className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-heading text-lg text-text-primary">
                        {t("workspace.currentJob", "Current job")}
                      </h2>
                      <div className="mt-1 truncate font-mono text-xs text-text-muted">
                        {currentJob.project_root}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-root px-2 py-1 text-xs font-semibold text-accent">
                      {currentJob.status}
                    </span>
                  </div>
                  <div className="mt-3 text-sm font-semibold text-text-primary">
                    {currentJob.kind}
                  </div>
                  {currentJob.error && (
                    <div className="mt-2 text-sm text-red-200">{currentJob.error}</div>
                  )}
                  {currentJob.logs.length > 0 && (
                    <div className="mt-3 max-h-[220px] overflow-auto rounded-md bg-root p-2 font-mono text-xs text-text-secondary">
                      {currentJob.logs.map((line, index) => (
                        <div key={`${line}-${index}`}>{line}</div>
                      ))}
                    </div>
                  )}
                </Panel>
              )}

              <Panel className="p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-heading text-lg text-text-primary">{t("common.projects", "Projects")}</h2>
                    <p className="mt-1 text-sm text-text-secondary">
                      {t("workspace.projectsDescription", "Open a registered graph or start a new analysis above.")}
                    </p>
                  </div>
                  <span className="text-xs uppercase tracking-wider text-text-muted">
                    {t("workspace.registeredProjects", "{count} registered", { count: projects.length })}
                  </span>
                </div>

                {projects.length === 0 ? (
                  <div className="rounded-md border border-border-subtle bg-elevated p-4 text-sm text-text-secondary">
                    {t("workspace.noProjects", "No registered projects yet.")}
                  </div>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2">
                    {projects.map((project) => (
                      <button
                        type="button"
                        key={project.project_id}
                        onClick={() => onOpenProject(projectParamsFromProject(project))}
                        className="w-full rounded-md border border-border-subtle bg-elevated p-3 text-left transition-colors hover:border-border-medium hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
              </Panel>
            </main>

            <aside className="space-y-4 xl:sticky xl:top-5 xl:self-start">
              <Panel className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-heading text-lg text-text-primary">
                      {t("workspace.initialConfiguration", "Initial Configuration")}
                    </h2>
                    <p className="mt-1 text-sm text-text-secondary">
                      {t("workspace.setupProgress", "{ready}/{total} ready", {
                        ready: setupReadyCount,
                        total: setupTotal,
                      })}
                    </p>
                  </div>
                  <StatusPill
                    ready={setupComplete}
                    label={setupComplete ? t("common.ready", "Ready") : t("workspace.setupRequired", "Setup required")}
                  />
                </div>

                <div className="mt-3">
                  <SetupRow
                    label={t("workspace.computerUseRuntime", "Computer Use runtime")}
                    ready={computerUseReady}
                    statusLabel={computerUseReady ? t("common.ready", "Ready") : t("common.missing", "Missing")}
                    detail={
                      <>
                        <span>{computerUseRuntimeLabel}</span>
                        <span className="mx-1 text-text-muted">·</span>
                        <span>
                          {t("workspace.computerUseDashboardUses", "Dashboard uses")} {dashboardConfigName}
                        </span>
                        {!computerUseReady && (
                          <span className="mt-1 block text-amber-200">
                            {t("workspace.computerUseSetupPath", "Config -> General -> Computer Use -> Runtime")} ·{" "}
                            {t("workspace.computerUseSetupValue", "local or sandbox")}
                          </span>
                        )}
                      </>
                    }
                  />
                  <SetupRow
                    label={t("subagents.title", "UA SubAgents")}
                    ready={subagentsReady}
                    statusLabel={subagentsReady ? t("common.ready", "Ready") : t("subagents.registrationRequired", "Registration required")}
                    detail={
                      subagentError ||
                      (blockedRoles.length > 0
                        ? blockedRoles.join(", ")
                        : t("subagents.allRegistered", "All roles registered"))
                    }
                    action={
                      showSubagentGuide || !subagentsReady ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void openSubagentProviderDialog()}
                            disabled={registeringSubagents}
                            className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-root transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            {registeringSubagents
                              ? t("subagents.registeringButton", "Registering UA SubAgents")
                              : t("subagents.registerButton", "Register UA SubAgents")}
                          </button>
                          {subagentsReady && (
                            <button
                              type="button"
                              onClick={dismissSubagentGuide}
                              className="rounded-md border border-border-medium bg-elevated px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              {t("common.dismiss", "Dismiss")}
                            </button>
                          )}
                        </div>
                      ) : undefined
                    }
                  />
                  <SetupRow
                    label={t("workspace.runtimeEnvironment", "Runtime Environment")}
                    ready={localRuntimeReady}
                    statusLabel={localRuntimeReady ? t("common.ready", "Ready") : t("common.missing", "Missing")}
                    detail={
                      runtimeReadiness?.blocking_reasons?.length
                        ? runtimeReadiness.blocking_reasons.join(" ")
                        : t("common.ready", "Ready")
                    }
                    action={
                      runtimeReadiness?.repair_needed ? (
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                          <div className="text-sm font-semibold text-amber-100">
                            {t("workspace.runtimeRepairNeeded", "Bundled runtime dependencies need repair.")}
                          </div>
                          {runtimeReadiness.repair_blocking_reasons.length > 0 && (
                            <div className="mt-1 text-sm leading-relaxed text-amber-100/80">
                              {runtimeReadiness.repair_blocking_reasons.join(" ")}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => void repairRuntime()}
                            disabled={!runtimeReadiness.repair_available || repairingRuntime}
                            className="mt-3 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-root transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            {repairingRuntime
                              ? t("workspace.repairingRuntime", "Repairing runtime")
                              : t("workspace.repairRuntime", "Repair plugin runtime")}
                          </button>
                        </div>
                      ) : undefined
                    }
                  />
                </div>

                {runtimeRepairMessage && (
                  <div className="mt-3 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-200">
                    {runtimeRepairMessage}
                  </div>
                )}
              </Panel>

              {disabledSessionComputerUse.length > 0 && (
                <Panel className="p-4">
                  <h2 className="font-heading text-base text-amber-100">
                    {t("workspace.computerUsePartialTitle", "Some conversation configs are unavailable")}
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-amber-100/80">
                    {t(
                      "workspace.computerUsePartialDescription",
                      "Dashboard analysis can start, but chat commands will fail in conversations bound to configs where Computer Use runtime is disabled.",
                    )}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {disabledSessionComputerUse.map((config) => (
                      <span
                        key={config.id}
                        className="rounded-md bg-root/70 px-2.5 py-1 text-xs text-amber-100"
                      >
                        {config.name}
                      </span>
                    ))}
                  </div>
                </Panel>
              )}

              <Panel className="p-4">
                <details className="group">
                  <summary className="cursor-pointer list-none text-sm font-semibold text-text-primary transition-colors hover:text-accent">
                    {t("workspace.environmentDetails", "Environment details")}
                  </summary>
                  <div className="mt-4 space-y-4">
                    <div>
                      <div className="mb-2 text-[11px] uppercase tracking-wider text-text-muted">
                        {t("workspace.runtimeToolCheck", "Runtime tool check")}
                      </div>
                      <div className="space-y-2">
                        {runtimeToolItems.map(({ key, label, tool }) => {
                          const ready = tool.supported;
                          const detail = runtimeToolDetail(tool, label, t);
                          return (
                            <div key={key} className="rounded-md bg-elevated px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-semibold text-text-primary">
                                  {label}
                                </span>
                                <span
                                  className={`text-xs font-semibold ${
                                    ready ? "text-green-400" : "text-amber-300"
                                  }`}
                                >
                                  {ready ? t("common.ready", "Ready") : t("common.missing", "Missing")}
                                </span>
                              </div>
                              <div
                                className="mt-1 truncate font-mono text-xs text-text-muted"
                                title={detail}
                              >
                                {detail}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 text-[11px] uppercase tracking-wider text-text-muted">
                        {t("workspace.computerUseRuntime", "Computer Use runtime")}
                      </div>
                      <div className="space-y-2">
                        {computerUseConfigs.map((config) => (
                          <div key={config.id} className="rounded-md bg-elevated px-3 py-2">
                            <div className="flex min-w-0 items-center justify-between gap-2">
                              <div className="min-w-0 truncate text-sm text-text-primary">
                                {config.name}
                                {config.is_default && (
                                  <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                                    {t("workspace.computerUseDefaultBadge", "Default")}
                                  </span>
                                )}
                              </div>
                              <span
                                className={`shrink-0 text-xs font-semibold ${
                                  config.enabled ? "text-green-400" : "text-amber-300"
                                }`}
                              >
                                {computerUseRuntimeName(config.runtime, t)}
                              </span>
                            </div>
                            {!config.enabled && config.blocking_reason && (
                              <div className="mt-1 text-xs text-amber-200">
                                {config.blocking_reason}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 text-[11px] uppercase tracking-wider text-text-muted">
                        {t("common.runtime", "Runtime")}
                      </div>
                      <div className="space-y-2">
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
                  </div>
                </details>
              </Panel>
            </aside>
          </div>
        )}
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
                className="rounded-md border border-border-medium bg-elevated px-2.5 py-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t("common.close", "Close")}
              </button>
            </div>

            <div className="space-y-3 px-4 py-4">
              <input
                type="search"
                value={providerSearch}
                onChange={(event) => setProviderSearch(event.target.value)}
                placeholder={t("subagents.providerSearch", "Search providers...")}
                className="w-full rounded-md border border-border-subtle bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
                    className={`w-full rounded-md border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
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
                        className={`w-full rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
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
                className="rounded-md border border-border-medium bg-elevated px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t("common.cancel", "Cancel")}
              </button>
              <button
                type="button"
                onClick={() => void registerSubagents()}
                disabled={providersLoading || registeringSubagents || providers.length === 0}
                className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-root transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
