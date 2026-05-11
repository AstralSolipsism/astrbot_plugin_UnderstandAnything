export interface AnalysisJobForm {
  target: string;
  fullAnalysis: boolean;
  autoUpdate: boolean;
}

export function looksLikeGitHubTarget(value: string): boolean {
  return /^https:\/\/github\.com\//i.test(value.trim());
}

export function buildAnalysisJobPayload(form: AnalysisJobForm): Record<string, unknown> {
  return {
    action: "understand",
    target: form.target.trim(),
    full: form.fullAnalysis,
    auto_update: form.autoUpdate,
  };
}
