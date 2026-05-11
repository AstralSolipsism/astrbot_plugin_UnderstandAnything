import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AstrBotPluginPageBridge,
  type JobSnapshot,
  type PluginStatus,
  type ProjectRefParams,
  type ProjectSummary,
  pluginGet,
  pluginPost,
  projectParamsFromProject,
} from "../utils/astrbotBridge";

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

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return "Not analyzed";
  return new Date(timestamp * 1000).toLocaleString();
}

function statusLabel(value: boolean): string {
  return value ? "Ready" : "Missing";
}

export default function AstrBotWorkspace({
  bridge,
  onOpenProject,
}: AstrBotWorkspaceProps) {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [fullAnalysis, setFullAnalysis] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [starting, setStarting] = useState(false);
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
      const [nextStatus, projectPayload] = await Promise.all([
        pluginGet<PluginStatus>(bridge, "status"),
        pluginGet<{ projects: ProjectSummary[] }>(bridge, "projects"),
      ]);
      setStatus(nextStatus);
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
              if (!cancelled) setError("Job event stream interrupted.");
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
  }, [bridge, currentJobId, currentJobStatus]);

  useEffect(() => {
    if (currentJob?.status !== "finished") return;
    if (openedFinishedJobId === currentJob.job_id) return;
    setOpenedFinishedJobId(currentJob.job_id);
    void loadWorkspace();
    onOpenProject({ project_path: currentJob.project_root });
  }, [currentJob, loadWorkspace, onOpenProject, openedFinishedJobId]);

  const runtimeItems = useMemo(() => {
    if (!status) return [];
    return [
      ["Runtime dist", status.runtime.runtime_dist?.exists],
      ["Core dist", status.runtime.core_dist?.exists],
      ["Dashboard dist", status.runtime.dashboard_dist?.exists],
      ["Dashboard page", status.runtime.dashboard_page?.exists],
      ["Node modules", status.runtime.node_modules?.exists],
    ] as const;
  }, [status]);

  const startAnalysis = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedPath = projectPath.trim();
    if (!trimmedPath) {
      setError("Project path is required.");
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const job = await pluginPost<JobSnapshot>(bridge, "jobs/start", {
        action: "understand",
        project_path: trimmedPath,
        full: fullAnalysis,
        auto_update: autoUpdate,
      });
      setCurrentJob(job);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="h-screen w-screen bg-root text-text-primary noise-overlay overflow-auto">
      <div className="mx-auto max-w-[1120px] px-4 py-5 sm:px-6 sm:py-7">
        <header className="mb-6 flex flex-col gap-3 border-b border-border-subtle pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-heading text-2xl text-text-primary">
              Understand Anything
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              AstrBot plugin workspace
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadWorkspace()}
              className="rounded-md border border-border-medium bg-elevated px-3 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Refresh
            </button>
            <a
              href="/#/extension/astrbot_plugin_UnderstandAnything"
              target="_top"
              className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-root transition-all hover:brightness-110"
            >
              Plugin Settings
            </a>
          </div>
        </header>

        {error && (
          <div className="mb-5 rounded-md border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <section className="mb-6 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-lg border border-border-subtle bg-surface p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-heading text-lg text-text-primary">
                  Initial Configuration
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Configuration is managed by AstrBot plugin settings.
                </p>
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                  loadState === "ready"
                    ? "bg-green-400/10 text-green-400"
                    : "bg-amber-400/10 text-amber-400"
                }`}
              >
                {loadState === "loading" ? "Loading" : loadState === "ready" ? "Ready" : "Error"}
              </span>
            </div>

            {status && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md bg-elevated p-3">
                  <div className="text-[11px] uppercase tracking-wider text-text-muted">
                    LLM Provider
                  </div>
                  <div className="mt-1 text-sm text-text-primary">
                    {status.config.provider_configured
                      ? "Configured"
                      : "Current session provider"}
                  </div>
                </div>
                <div className="rounded-md bg-elevated p-3">
                  <div className="text-[11px] uppercase tracking-wider text-text-muted">
                    Node Runtime
                  </div>
                  <div className="mt-1 text-sm text-text-primary">
                    {status.config.node_bin} / {status.config.pnpm_bin}
                  </div>
                </div>
                <div className="rounded-md bg-elevated p-3 sm:col-span-2">
                  <div className="text-[11px] uppercase tracking-wider text-text-muted">
                    Allowed Roots
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
            <h2 className="font-heading text-lg text-text-primary">Runtime</h2>
            <div className="mt-4 space-y-2">
              {runtimeItems.map(([label, exists]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-3 rounded-md bg-elevated px-3 py-2"
                >
                  <span className="text-sm text-text-secondary">{label}</span>
                  <span
                    className={`text-xs font-semibold ${
                      exists ? "text-green-400" : "text-amber-400"
                    }`}
                  >
                    {statusLabel(Boolean(exists))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-lg border border-border-subtle bg-surface p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="font-heading text-lg text-text-primary">Projects</h2>
              <span className="text-xs uppercase tracking-wider text-text-muted">
                {projects.length} registered
              </span>
            </div>

            {projects.length === 0 ? (
              <div className="rounded-md border border-border-subtle bg-elevated p-4 text-sm text-text-secondary">
                No registered projects yet.
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
                        <div className="mt-1 truncate font-mono text-xs text-text-muted">
                          {project.path}
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-accent/10 px-2 py-1 text-[11px] font-semibold text-accent">
                        Open
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-text-muted">
                      {formatDate(project.last_analyzed_at)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border-subtle bg-surface p-4">
            <h2 className="font-heading text-lg text-text-primary">Analyze Project</h2>
            <form onSubmit={startAnalysis} className="mt-4 space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-wider text-text-muted">
                  Project Path
                </span>
                <input
                  type="text"
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                  placeholder="D:\\path\\to\\project"
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
                  Full analysis
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={autoUpdate}
                    onChange={(event) => setAutoUpdate(event.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  Auto update
                </label>
              </div>

              <button
                type="submit"
                disabled={starting || !projectPath.trim()}
                className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-root transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {starting ? "Starting..." : "Start Analysis"}
              </button>
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
    </div>
  );
}
