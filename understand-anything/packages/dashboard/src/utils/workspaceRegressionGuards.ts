import { looksLikeGitHubTarget } from "./analysisRequest";

export const ASTRBOT_WORKSPACE_READ_ENDPOINTS = [
  "status",
  "projects",
  "jobs",
  "subagents/status",
  "file-content",
] as const;

export const ASTRBOT_WORKSPACE_REQUIRED_ACTIONS = [
  "runtime/repair",
  "subagents/providers",
  "subagents/register",
  "jobs/start",
  "jobs/<job_id>",
  "jobs/<job_id>/events",
  "jobs/<job_id>/confirm",
  "jobs/<job_id>/retry",
  "projects/delete",
  "projects/check-updates",
  "projects/ignore",
] as const;

export const ASTRBOT_RUNTIME_DEPENDENCY_ITEMS = [
  {
    key: "runtimeItems.runtimeDist",
    fallback: "Runtime command bundle",
    descriptionKey: "runtimeItemDescriptions.runtimeDist",
    descriptionFallback: "Compiled runtime commands used by project analysis.",
    statusKey: "runtime_dist",
  },
  {
    key: "runtimeItems.coreDist",
    fallback: "Core analysis bundle",
    descriptionKey: "runtimeItemDescriptions.coreDist",
    descriptionFallback: "Compiled graph, validation, parser, and language analysis code.",
    statusKey: "core_dist",
  },
  {
    key: "runtimeItems.assistantDist",
    fallback: "Assistant context bundle",
    descriptionKey: "runtimeItemDescriptions.assistantDist",
    descriptionFallback: "Compiled context builders used when answering from project graphs.",
    statusKey: "assistant_dist",
  },
  {
    key: "runtimeItems.dashboardDist",
    fallback: "Dashboard build",
    descriptionKey: "runtimeItemDescriptions.dashboardDist",
    descriptionFallback: "Built dashboard assets used by the plugin page.",
    statusKey: "dashboard_dist",
  },
  {
    key: "runtimeItems.dashboardPage",
    fallback: "Dashboard page",
    descriptionKey: "runtimeItemDescriptions.dashboardPage",
    descriptionFallback: "Static plugin page entry served by AstrBot.",
    statusKey: "dashboard_page",
  },
  {
    key: "runtimeItems.runtimePackages",
    fallback: "Runtime package set",
    descriptionKey: "runtimeItemDescriptions.runtimePackages",
    descriptionFallback:
      "Plugin runtime packages installed by repair; not dependencies of the project being analyzed.",
    statusKey: "node_modules",
  },
] as const;

export interface AnalyzeStartBlockerInput {
  target: string;
  subagentError: string | null;
  subagentsReady: boolean;
  computerUseReady: boolean;
  localRuntimeReady: boolean;
  runtimeBlockingReasons: string[];
  projectTargetRequiredMessage: string;
  subagentsRequiredMessage: string;
  computerUseRequiredMessage: string;
  runtimeUnavailableMessage: string;
  githubAnalysisReady: boolean;
  githubBlockingReason: string;
  gitUnavailableMessage: string;
}

export function analyzeStartBlocker(input: AnalyzeStartBlockerInput): string | null {
  const target = input.target.trim();
  if (!target) return input.projectTargetRequiredMessage;
  if (input.subagentError) return input.subagentError;
  if (!input.subagentsReady) return input.subagentsRequiredMessage;
  if (!input.computerUseReady) return input.computerUseRequiredMessage;
  if (!input.localRuntimeReady) {
    return input.runtimeBlockingReasons.length > 0
      ? input.runtimeBlockingReasons.join(" ")
      : input.runtimeUnavailableMessage;
  }
  if (looksLikeGitHubTarget(target) && !input.githubAnalysisReady) {
    return input.githubBlockingReason || input.gitUnavailableMessage;
  }
  return null;
}

export interface JobEventFallbackInput {
  hasSubscribeSSE: boolean;
  subscribeFailed?: boolean;
}

export function shouldUseJobEventPollingFallback(input: JobEventFallbackInput): boolean {
  return !input.hasSubscribeSSE || input.subscribeFailed === true;
}
