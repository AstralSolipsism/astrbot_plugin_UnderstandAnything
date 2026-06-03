import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import {
  type AstrBotPluginPageBridge,
  type JobSnapshot,
  type PluginStatus,
  type ProjectIgnorePayload,
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
import {
  isActiveJob,
  isTerminalJobStatus,
  jobForProject,
  projectAnalysisTarget,
  recentActivity,
  selectRecoverableJob,
} from "../utils/jobTracking";
import { getStorageItem, removeStorageItem, setStorageItem } from "../utils/safeBrowser";
import { analyzeStartBlocker } from "../utils/workspaceRegressionGuards";

interface AstrBotWorkspaceProps {
  bridge: AstrBotPluginPageBridge;
  onOpenProject: (params: ProjectRefParams) => void;
}

type LoadState = "loading" | "ready" | "error";
type ConfirmationAction = "continue" | "cancel" | "update";

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

function OptionHelp({
  label,
  children
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] font-semibold leading-none text-text-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        ?
      </button>
      <span className="pointer-events-none invisible absolute left-0 top-full z-30 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-surface p-3 text-xs leading-relaxed text-text-secondary opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 sm:left-1/2 sm:-translate-x-1/2">
        {children}
      </span>
    </span>
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
  const { locale, t } = useI18n();
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [subagents, setSubagents] = useState<SubAgentSetupStatus | null>(null);
  const [subagentError, setSubagentError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
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
  const [showJobLogs, setShowJobLogs] = useState(false);
  const [confirmationContent, setConfirmationContent] = useState("");
  const [confirmingAction, setConfirmingAction] = useState<ConfirmationAction | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [jobRefreshNotice, setJobRefreshNotice] = useState<string | null>(null);
  const [ignorePanelOpen, setIgnorePanelOpen] = useState(false);
  const [ignorePayload, setIgnorePayload] = useState<ProjectIgnorePayload | null>(null);
  const [ignoreContent, setIgnoreContent] = useState("");
  const [ignoreLoading, setIgnoreLoading] = useState(false);
  const [ignoreSaving, setIgnoreSaving] = useState(false);
  const [ignoreError, setIgnoreError] = useState<string | null>(null);
  const [openedFinishedJobId, setOpenedFinishedJobId] = useState<string | null>(
    null,
  );
  const currentJobId = currentJob?.job_id;
  const currentJobStatus = currentJob?.status;
  const currentConfirmation = currentJob?.confirmation ?? null;
  const confirmationSummary = currentConfirmation?.summary;
  const confirmationDetectedDirs = confirmationSummary?.detected_dirs ?? [];
  const confirmationGitignorePatterns = confirmationSummary?.gitignore_patterns ?? [];
  const confirmationTestPatterns = confirmationSummary?.test_file_patterns ?? [];
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
      const [nextStatus, projectPayload, jobPayload] = await Promise.all([
        pluginGet<PluginStatus>(bridge, "status"),
        pluginGet<{ projects: ProjectSummary[] }>(bridge, "projects"),
        pluginGet<{ jobs: JobSnapshot[] }>(bridge, "jobs"),
      ]);
      setStatus(nextStatus);
      setProjects(projectPayload.projects);
      setJobs(jobPayload.jobs);
      setCurrentJob((existingJob) =>
        selectRecoverableJob(jobPayload.jobs, existingJob),
      );

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
    if (projects.length === 0) {
      if (selectedProjectId) setSelectedProjectId(null);
      return;
    }
    if (
      !selectedProjectId ||
      !projects.some((project) => project.project_id === selectedProjectId)
    ) {
      setSelectedProjectId(projects[0].project_id);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    setConfirmationContent(currentConfirmation?.content ?? "");
  }, [currentJobId, currentConfirmation?.content]);

  useEffect(() => {
    setIgnorePanelOpen(false);
    setIgnorePayload(null);
    setIgnoreContent("");
    setIgnoreError(null);
  }, [selectedProjectId]);

  useEffect(() => {
    if (
      !currentJobId ||
      !currentJobStatus ||
      isTerminalJobStatus(currentJobStatus)
    ) {
      setJobRefreshNotice(null);
      return;
    }
    let cancelled = false;
    let intervalId: number | undefined;
    let subscriptionId: string | null = null;
    let pollFailures = 0;

    const updateJob = (value: unknown) => {
      if (!cancelled && isJobSnapshot(value)) {
        setCurrentJob(value);
        setJobs((previousJobs) => [
          value,
          ...previousJobs.filter((job) => job.job_id !== value.job_id),
        ]);
        setJobRefreshNotice(null);
      }
    };

    const pollJob = async () => {
      try {
        const nextJob = await pluginGet<JobSnapshot>(bridge, `jobs/${currentJobId}`);
        pollFailures = 0;
        updateJob(nextJob);
      } catch {
        pollFailures += 1;
        if (!cancelled && pollFailures >= 3) {
          setJobRefreshNotice(
            t(
              "workspace.jobRefreshDelayed",
              "Progress refresh is temporarily delayed. The job is still tracked by AstrBot.",
            ),
          );
        }
      }
    };

    const startPolling = () => {
      if (intervalId !== undefined) return;
      void pollJob();
      intervalId = window.setInterval(() => {
        void pollJob();
      }, 2500);
    };

    if (bridge.subscribeSSE) {
      bridge
        .subscribeSSE(
          `jobs/${currentJobId}/events`,
          {
            onOpen: () => {
              if (!cancelled) setJobRefreshNotice(null);
            },
            onMessage: (event) => updateJob(event.parsed),
            onError: () => {
              if (!cancelled) startPolling();
            },
          },
        )
        .then((id) => {
          subscriptionId = id;
        })
        .catch((subscribeError) => {
          if (!cancelled) {
            startPolling();
            console.debug("Understand Anything job SSE unavailable:", subscribeError);
          }
        });
    } else {
      startPolling();
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
  const selectedProject = useMemo(() => {
    if (projects.length === 0) return null;
    if (selectedProjectId) {
      const matched = projects.find(
        (project) => project.project_id === selectedProjectId,
      );
      if (matched) return matched;
    }
    return projects[0] ?? null;
  }, [projects, selectedProjectId]);
  const selectedProjectJob = selectedProject
    ? jobForProject(selectedProject, jobs)
    : null;
  const focusedJob = selectedProject ? selectedProjectJob : currentJob;

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

  const analysisBlockerForTarget = useCallback(
    (target: string): string | null =>
      analyzeStartBlocker({
        target,
        subagentError,
        subagentsReady,
        computerUseReady,
        localRuntimeReady,
        runtimeBlockingReasons: runtimeReadiness?.blocking_reasons ?? [],
        projectTargetRequiredMessage: t(
          "workspace.projectTargetRequired",
          "Project target is required.",
        ),
        subagentsRequiredMessage: t(
          "workspace.subagentsRequired",
          "Register UA SubAgents before starting analysis.",
        ),
        computerUseRequiredMessage: t(
          "workspace.computerUseRequired",
          "Enable Computer Use runtime before starting analysis.",
        ),
        runtimeUnavailableMessage: t(
          "workspace.runtimeUnavailable",
          "Understand Anything runtime is not ready.",
        ),
        githubAnalysisReady: runtimeReadiness?.github_analysis_ready ?? true,
        githubBlockingReason: runtimeReadiness?.github_blocking_reason || "",
        gitUnavailableMessage: t(
          "workspace.gitUnavailable",
          "Git is unavailable on this AstrBot host.",
        ),
      }),
    [
      computerUseReady,
      localRuntimeReady,
      runtimeReadiness?.blocking_reasons,
      runtimeReadiness?.github_analysis_ready,
      runtimeReadiness?.github_blocking_reason,
      subagentError,
      subagentsReady,
      t,
    ],
  );

  const startAnalysisForTarget = async (
    target: string,
    nextAutoUpdate = autoUpdate,
  ) => {
    const trimmedTarget = target.trim();
    const blocker = analysisBlockerForTarget(trimmedTarget);
    if (blocker) {
      setError(blocker);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      setProjectTarget(trimmedTarget);
      const job = await pluginPost<JobSnapshot>(
        bridge,
        "jobs/start",
        buildAnalysisJobPayload({
          target: trimmedTarget,
          fullAnalysis,
          autoUpdate: nextAutoUpdate,
          githubProxy,
          locale,
        }),
      );
      setCurrentJob(job);
      setShowJobLogs(false);
      setJobs((previousJobs) => [
        job,
        ...previousJobs.filter((item) => item.job_id !== job.job_id),
      ]);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setStarting(false);
    }
  };

  const startAnalysis = async (event: React.FormEvent) => {
    event.preventDefault();
    await startAnalysisForTarget(projectTarget);
  };

  const restartProject = async (project: ProjectSummary) => {
    const target = projectAnalysisTarget(project);
    if (!target) {
      setError(t("workspace.projectTargetRequired", "Project target is required."));
      return;
    }
    await startAnalysisForTarget(target, Boolean(project.auto_update));
  };

  const [projectPendingDelete, setProjectPendingDelete] = useState<ProjectSummary | null>(null);

  const deleteProject = async (project: ProjectSummary) => {
    if (isActiveJob(jobForProject(project, jobs))) {
      setError(
        t(
          "workspace.deleteBlockedActiveJob",
          "Project analysis is still running. Wait for the job to finish before deleting it.",
        ),
      );
      return;
    }
    setProjectPendingDelete(project);
  };

  const confirmDeleteProject = async () => {
    const project = projectPendingDelete;
    if (!project) return;
    if (isActiveJob(jobForProject(project, jobs))) {
      setProjectPendingDelete(null);
      setError(
        t(
          "workspace.deleteBlockedActiveJob",
          "Project analysis is still running. Wait for the job to finish before deleting it.",
        ),
      );
      return;
    }
    setDeletingProjectId(project.project_id);
    setError(null);
    try {
      await pluginPost<{ project: ProjectSummary; graph_deleted: boolean }>(
        bridge,
        "projects/delete",
        { project_id: project.project_id },
      );
      setProjects((previousProjects) =>
        previousProjects.filter((item) => item.project_id !== project.project_id),
      );
      setJobs((previousJobs) =>
        previousJobs.filter((job) => job.args.project_id !== project.project_id),
      );
      if (currentJob && currentJob.args.project_id === project.project_id) {
        setCurrentJob(null);
      }
      setProjectPendingDelete(null);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setDeletingProjectId(null);
    }
  };

  const loadIgnoreRules = async (project: ProjectSummary) => {
    setIgnorePanelOpen(true);
    setIgnoreLoading(true);
    setIgnoreError(null);
    try {
      const payload = await pluginGet<ProjectIgnorePayload>(
        bridge,
        "projects/ignore",
        { project_id: project.project_id },
      );
      setIgnorePayload(payload);
      setIgnoreContent(payload.content);
    } catch (loadError) {
      setIgnoreError(errorMessage(loadError));
    } finally {
      setIgnoreLoading(false);
    }
  };

  const saveIgnoreRules = async () => {
    if (!selectedProject) return;
    setIgnoreSaving(true);
    setIgnoreError(null);
    try {
      const payload = await pluginPost<ProjectIgnorePayload>(
        bridge,
        "projects/ignore",
        { project_id: selectedProject.project_id, content: ignoreContent },
      );
      setIgnorePayload(payload);
      setIgnoreContent(payload.content);
    } catch (saveError) {
      setIgnoreError(errorMessage(saveError));
    } finally {
      setIgnoreSaving(false);
    }
  };

  const submitJobConfirmation = async (action: ConfirmationAction) => {
    if (!currentJob) return;
    setConfirmingAction(action);
    setError(null);
    try {
      const nextJob = await pluginPost<JobSnapshot>(
        bridge,
        `jobs/${currentJob.job_id}/confirm`,
        {
          action,
          content: action === "cancel" ? undefined : confirmationContent,
        },
      );
      setCurrentJob(nextJob);
      setJobs((previousJobs) => [
        nextJob,
        ...previousJobs.filter((job) => job.job_id !== nextJob.job_id),
      ]);
    } catch (confirmationError) {
      setError(errorMessage(confirmationError));
    } finally {
      setConfirmingAction(null);
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
    analysisBlockerForTarget(projectTarget) === null;

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
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
            <main className="flex flex-col gap-5">
              <Panel className="order-2 p-4 sm:p-5">
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
                          {t(
                            "workspace.githubProxyDirect",
                            "Automatic: direct, then proxies",
                          )}
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
                          "Direct GitHub is tried first. If it fails with a network error, AstrBot falls back to bundled proxy presets.",
                        )}
                      </p>
                    </label>
                  )}

                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap gap-3">
                      <div className="inline-flex items-center gap-2 text-sm text-text-secondary">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={fullAnalysis}
                            onChange={(event) => setFullAnalysis(event.target.checked)}
                            className="h-4 w-4 accent-[var(--color-accent)]"
                          />
                          {t("workspace.fullAnalysis", "Full analysis")}
                        </label>
                        <OptionHelp
                          label={t(
                            "workspace.fullAnalysisHelpLabel",
                            "What does full analysis do?",
                          )}
                        >
                          {t(
                            "workspace.fullAnalysisHelp",
                            "Force this run to rebuild the whole graph from scratch. Leave it off to reuse the existing graph and analyze only changed files when possible.",
                          )}
                        </OptionHelp>
                      </div>
                      <div className="inline-flex items-center gap-2 text-sm text-text-secondary">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={autoUpdate}
                            onChange={(event) => setAutoUpdate(event.target.checked)}
                            className="h-4 w-4 accent-[var(--color-accent)]"
                          />
                          {t("workspace.autoUpdate", "Auto update")}
                        </label>
                        <OptionHelp
                          label={t(
                            "workspace.autoUpdateHelpLabel",
                            "What does auto update do?",
                          )}
                        >
                          {t(
                            "workspace.autoUpdateHelp",
                            "Save this project for background updates. When Git HEAD changes later, AstrBot can start an incremental analysis automatically.",
                          )}
                        </OptionHelp>
                      </div>
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
                <Panel className="order-3 p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-heading text-lg text-text-primary">
                        {t("workspace.analysisTracking", "Analysis Tracking")}
                      </h2>
                      <div className="mt-1 truncate font-mono text-xs text-text-muted">
                        {currentJob.project_root}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-root px-2 py-1 text-xs font-semibold text-accent">
                      {currentJob.status}
                    </span>
                  </div>
                  <div className="mt-4">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-semibold text-text-primary">
                        {currentJob.progress?.label || currentJob.kind}
                      </span>
                      <span className="font-mono text-xs text-text-muted">
                        {Math.round(currentJob.progress?.percent ?? 0)}%
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-root">
                      <div
                        className="h-full rounded-full bg-accent transition-[width]"
                        style={{ width: `${Math.round(currentJob.progress?.percent ?? 0)}%` }}
                      />
                    </div>
                  </div>
                  {jobRefreshNotice && (
                    <div className="mt-3 rounded-md border border-border-subtle bg-elevated px-3 py-2 text-sm text-text-muted">
                      {jobRefreshNotice}
                    </div>
                  )}
                  {currentJob.progress?.steps?.length ? (
                    <div className="mt-4 grid gap-2 sm:grid-cols-3">
                      {currentJob.progress.steps.map((step) => (
                        <div
                          key={step.phase}
                          className={`rounded-md border px-3 py-2 text-xs ${
                            step.status === "complete"
                              ? "border-green-400/20 bg-green-400/10 text-green-200"
                              : step.status === "active"
                                ? "border-accent/40 bg-accent/10 text-accent"
                                : step.status === "failed" || step.status === "cancelled"
                                  ? "border-red-700 bg-red-900/30 text-red-200"
                                  : "border-border-subtle bg-elevated text-text-muted"
                          }`}
                        >
                          <div className="font-semibold">{step.label}</div>
                          <div className="mt-1 font-mono uppercase tracking-wider">
                            {step.status}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {currentJob.status === "waiting_confirmation" && currentConfirmation && (
                    <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 p-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <h3 className="text-sm font-semibold text-text-primary">
                            {t("workspace.confirmIgnoreTitle", "Confirm scan scope")}
                          </h3>
                          <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                            {t(
                              "workspace.confirmIgnoreDescription",
                              "Review the generated .understandignore rules before the agent workflow starts.",
                            )}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-root px-2 py-1 text-[11px] font-semibold text-accent">
                          {confirmationSummary?.generated
                            ? t("workspace.generatedIgnoreRules", "Generated")
                            : t("workspace.existingIgnoreRules", "Existing")}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                        <div className="rounded-md bg-root/70 px-3 py-2">
                          <div className="font-semibold text-text-primary">
                            {t("workspace.detectedDirectories", "Detected directories")}
                          </div>
                          <div className="mt-1 text-text-muted">
                            {confirmationDetectedDirs.length
                              ? confirmationDetectedDirs.join(", ")
                              : t("common.none", "None")}
                          </div>
                        </div>
                        <div className="rounded-md bg-root/70 px-3 py-2">
                          <div className="font-semibold text-text-primary">
                            {t("workspace.gitignoreSuggestions", ".gitignore suggestions")}
                          </div>
                          <div className="mt-1 text-text-muted">
                            {confirmationGitignorePatterns.length
                              ? confirmationGitignorePatterns.join(", ")
                              : t("common.none", "None")}
                          </div>
                        </div>
                        <div className="rounded-md bg-root/70 px-3 py-2">
                          <div className="font-semibold text-text-primary">
                            {t("workspace.testFilePatterns", "Test file patterns")}
                          </div>
                          <div className="mt-1 text-text-muted">
                            {confirmationTestPatterns.length
                              ? confirmationTestPatterns.join(", ")
                              : t("common.none", "None")}
                          </div>
                        </div>
                      </div>
                      <label className="mt-3 block">
                        <span className="mb-1 block text-xs uppercase tracking-wider text-text-muted">
                          {t("workspace.ignoreRules", ".understandignore rules")}
                        </span>
                        <textarea
                          value={confirmationContent}
                          onChange={(event) => setConfirmationContent(event.target.value)}
                          rows={10}
                          className="w-full rounded-md border border-border-subtle bg-root px-3 py-2 font-mono text-xs leading-relaxed text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        />
                      </label>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void submitJobConfirmation("update")}
                          disabled={Boolean(confirmingAction)}
                          className="rounded-md border border-border-medium bg-root px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          {confirmingAction === "update"
                            ? t("workspace.updatingIgnoreRules", "Updating")
                            : t("workspace.updateIgnoreRules", "Update rules")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void submitJobConfirmation("continue")}
                          disabled={Boolean(confirmingAction)}
                          className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-root transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          {confirmingAction === "continue"
                            ? t("workspace.confirmingIgnoreRules", "Confirming")
                            : t("workspace.continueAnalysis", "Continue analysis")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void submitJobConfirmation("cancel")}
                          disabled={Boolean(confirmingAction)}
                          className="rounded-md border border-red-700/60 bg-red-900/20 px-3 py-2 text-xs font-semibold text-red-200 transition-colors hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
                        >
                          {confirmingAction === "cancel"
                            ? t("workspace.cancellingAnalysis", "Cancelling")
                            : t("workspace.cancelAnalysis", "Cancel analysis")}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="mt-3 rounded-md border border-border-subtle bg-elevated px-3 py-2 text-sm text-text-secondary">
                    {recentActivity(currentJob)}
                  </div>
                  {currentJob.error && (
                    <div className="mt-2 text-sm text-red-200">{currentJob.error}</div>
                  )}
                  {currentJob.logs.length > 0 && (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => setShowJobLogs((value) => !value)}
                        className="rounded-md border border-border-medium bg-elevated px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {showJobLogs
                          ? t("workspace.hideRawLogs", "Hide raw logs")
                          : t("workspace.showRawLogs", "Show raw logs")}
                      </button>
                      {showJobLogs && (
                        <div className="mt-2 max-h-[220px] overflow-auto rounded-md bg-root p-2 font-mono text-xs text-text-secondary">
                          {currentJob.logs.map((line, index) => (
                            <div key={`${line}-${index}`}>{line}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Panel>
              )}

              <Panel className="order-1 p-4 sm:p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-heading text-xl text-text-primary">{t("common.projects", "Projects")}</h2>
                    <p className="mt-1 text-sm text-text-secondary">
                      {t("workspace.projectsDescription", "Open a registered graph, inspect the latest job, or start a new analysis.")}
                    </p>
                  </div>
                  <span className="text-xs uppercase tracking-wider text-text-muted">
                    {t("workspace.registeredProjects", "{count} registered", { count: projects.length })}
                  </span>
                </div>

                {projects.length === 0 ? (
                  <div className="rounded-md border border-border-subtle bg-elevated p-4 text-sm text-text-secondary">
                    {t("workspace.noProjects", "No registered projects yet. Add a local path or GitHub repository below to start analysis.")}
                  </div>
                ) : (
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.1fr)]">
                    <div className="space-y-2">
                      {projects.map((project) => {
                        const projectJob = jobForProject(project, jobs);
                        const projectActive = isActiveJob(projectJob);
                        const projectJobStatus = projectJob?.status;
                        const selected = selectedProject?.project_id === project.project_id;
                        return (
                          <button
                            type="button"
                            key={project.project_id}
                            onClick={() => setSelectedProjectId(project.project_id)}
                            className={`w-full rounded-md border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                              selected
                                ? "border-accent bg-accent/10"
                                : "border-border-subtle bg-elevated hover:border-border-medium"
                            }`}
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
                              <span
                                className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${
                                  projectActive
                                    ? "bg-accent/10 text-accent"
                                    : projectJobStatus === "failed"
                                      ? "bg-red-900/40 text-red-200"
                                      : "bg-root text-text-muted"
                                }`}
                              >
                                {projectJobStatus ??
                                  (project.last_analyzed_at
                                    ? t("workspace.graphReady", "Ready")
                                    : t("workspace.notAnalyzed", "Not analyzed"))}
                              </span>
                            </div>
                            <div className="mt-2 text-xs text-text-muted">
                              {formatDate(project.last_analyzed_at, t("workspace.notAnalyzed", "Not analyzed"))}
                            </div>
                            {projectJob && (
                              <div className="mt-2 truncate rounded-md bg-root px-2 py-1.5 text-xs text-text-secondary">
                                {recentActivity(projectJob)}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    <div className="rounded-md border border-border-subtle bg-elevated p-4">
                      {selectedProject ? (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                                {t("workspace.selectedProject", "Selected project")}
                              </div>
                              <h3 className="mt-1 truncate font-heading text-xl text-text-primary">
                                {selectedProject.name}
                              </h3>
                              <div className="mt-1 truncate font-mono text-xs text-text-muted">
                                {selectedProject.path}
                              </div>
                            </div>
                            <StatusPill
                              ready={Boolean(selectedProject.last_analyzed_at)}
                              label={
                                selectedProject.last_analyzed_at
                                  ? t("workspace.graphReady", "Ready")
                                  : t("workspace.notAnalyzed", "Not analyzed")
                              }
                            />
                          </div>

                          <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            <div className="rounded-md bg-root px-3 py-2">
                              <div className="text-xs text-text-muted">
                                {t("workspace.lastAnalyzed", "Last analyzed")}
                              </div>
                              <div className="mt-1 text-sm text-text-primary">
                                {formatDate(selectedProject.last_analyzed_at, t("workspace.notAnalyzed", "Not analyzed"))}
                              </div>
                            </div>
                            <div className="rounded-md bg-root px-3 py-2">
                              <div className="text-xs text-text-muted">
                                {t("workspace.autoUpdate", "Auto update")}
                              </div>
                              <div className="mt-1 text-sm text-text-primary">
                                {selectedProject.auto_update ? t("common.on", "On") : t("common.off", "Off")}
                              </div>
                            </div>
                          </div>

                          {focusedJob && (
                            <div className="mt-4 rounded-md border border-border-subtle bg-root p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-text-primary">
                                    {focusedJob.progress?.label || focusedJob.kind}
                                  </div>
                                  <div className="mt-1 truncate text-xs text-text-muted">
                                    {recentActivity(focusedJob)}
                                  </div>
                                </div>
                                <span className="shrink-0 rounded-full bg-elevated px-2 py-1 text-[11px] font-semibold text-accent">
                                  {focusedJob.status}
                                </span>
                              </div>
                              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-elevated">
                                <div
                                  className="h-full rounded-full bg-accent transition-[width]"
                                  style={{ width: `${Math.round(focusedJob.progress?.percent ?? 0)}%` }}
                                />
                              </div>
                              {jobRefreshNotice && focusedJob.job_id === currentJobId && (
                                <div className="mt-3 rounded-md border border-border-subtle bg-elevated px-3 py-2 text-xs text-text-muted">
                                  {jobRefreshNotice}
                                </div>
                              )}
                            </div>
                          )}

                          <div className="mt-4 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => onOpenProject(projectParamsFromProject(selectedProject))}
                              className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-root transition-[filter,opacity] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              {t("workspace.openGraph", "Open graph")}
                            </button>
                            <button
                              type="button"
                              onClick={() => void restartProject(selectedProject)}
                              disabled={
                                starting ||
                                analysisBlockerForTarget(projectAnalysisTarget(selectedProject)) !== null
                              }
                              className="rounded-md border border-border-medium bg-root px-3 py-2 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              {t("workspace.reanalyzeProject", "Reanalyze")}
                            </button>
                            <button
                              type="button"
                              onClick={() => void loadIgnoreRules(selectedProject)}
                              className="rounded-md border border-border-medium bg-root px-3 py-2 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              {t("workspace.scanRules", "Scan rules")}
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteProject(selectedProject)}
                              disabled={
                                deletingProjectId === selectedProject.project_id ||
                                isActiveJob(selectedProjectJob)
                              }
                              className="rounded-md border border-red-700/60 bg-red-900/20 px-3 py-2 text-sm font-semibold text-red-200 transition-colors hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
                            >
                              {deletingProjectId === selectedProject.project_id
                                ? t("workspace.deletingProject", "Deleting")
                                : t("workspace.deleteProject", "Delete")}
                            </button>
                          </div>

                          {ignorePanelOpen && (
                            <div className="mt-4 rounded-md border border-border-subtle bg-root p-3">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-sm font-semibold text-text-primary">
                                    {t("workspace.scanRulesTitle", "Scan exclusion rules")}
                                  </div>
                                  <div className="mt-1 text-xs leading-relaxed text-text-muted">
                                    {ignorePayload?.exists
                                      ? t("workspace.scanRulesExisting", "These rules are active for the next scan.")
                                      : t("workspace.scanRulesSuggested", "These are commented suggestions. Save only the rules you want to activate.")}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setIgnorePanelOpen(false)}
                                  className="rounded-md border border-border-medium bg-elevated px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                                >
                                  {t("common.close", "Close")}
                                </button>
                              </div>
                              {ignoreLoading ? (
                                <div className="mt-3 rounded-md border border-border-subtle bg-elevated px-3 py-3 text-sm text-text-secondary">
                                  {t("common.loading", "Loading")}
                                </div>
                              ) : (
                                <>
                                  <textarea
                                    value={ignoreContent}
                                    onChange={(event) => setIgnoreContent(event.target.value)}
                                    rows={10}
                                    className="mt-3 w-full rounded-md border border-border-subtle bg-elevated px-3 py-2 font-mono text-xs leading-relaxed text-text-primary placeholder:text-text-muted/50 focus:border-accent focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                                  />
                                  {ignoreError && (
                                    <div className="mt-2 text-sm text-red-200">
                                      {ignoreError}
                                    </div>
                                  )}
                                  <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => void saveIgnoreRules()}
                                      disabled={ignoreSaving}
                                      className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-root transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                                    >
                                      {ignoreSaving
                                        ? t("workspace.savingScanRules", "Saving")
                                        : t("workspace.saveScanRules", "Save scan rules")}
                                    </button>
                                    <span className="truncate font-mono text-xs text-text-muted">
                                      {ignorePayload?.ignore_path}
                                    </span>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="rounded-md border border-border-subtle bg-root p-4 text-sm text-text-secondary">
                          {t("workspace.noProjects", "No registered projects yet. Add a local path or GitHub repository below to start analysis.")}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </Panel>

              {projectPendingDelete && (
                <div
                  className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
                  role="presentation"
                  onMouseDown={(event) => {
                    if (event.currentTarget === event.target && !deletingProjectId) {
                      setProjectPendingDelete(null);
                    }
                  }}
                >
                  <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="delete-project-title"
                    className="w-full max-w-md rounded-xl border border-red-700/50 bg-elevated p-5 shadow-2xl shadow-black/50"
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <div className="text-xs font-semibold uppercase tracking-wider text-red-200">
                      {t("workspace.deleteProject", "Delete")}
                    </div>
                    <h3 id="delete-project-title" className="mt-2 font-heading text-xl text-text-primary">
                      {t("workspace.deleteProjectTitle", "Delete project graph?")}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                      {t(
                        "workspace.deleteProjectConfirm",
                        "Delete this project's Understand Anything graph data? Source files will not be deleted.",
                      )}
                    </p>
                    <div className="mt-4 rounded-md border border-border-subtle bg-root p-3">
                      <div className="truncate text-sm font-semibold text-text-primary">
                        {projectPendingDelete.name}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-text-muted">
                        {projectPendingDelete.path}
                      </div>
                    </div>
                    <div className="mt-5 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setProjectPendingDelete(null)}
                        disabled={Boolean(deletingProjectId)}
                        className="rounded-md border border-border-medium bg-root px-3 py-2 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {t("common.cancel", "Cancel")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void confirmDeleteProject()}
                        disabled={Boolean(deletingProjectId)}
                        className="rounded-md border border-red-700/60 bg-red-900/40 px-3 py-2 text-sm font-semibold text-red-200 transition-colors hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
                      >
                        {deletingProjectId
                          ? t("workspace.deletingProject", "Deleting")
                          : t("workspace.deleteProject", "Delete")}
                      </button>
                    </div>
                  </div>
                </div>
              )}
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
