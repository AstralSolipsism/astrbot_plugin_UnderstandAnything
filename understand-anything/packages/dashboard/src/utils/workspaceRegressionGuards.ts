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
