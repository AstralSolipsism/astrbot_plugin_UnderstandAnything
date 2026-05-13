export interface AnalysisJobForm {
  target: string;
  fullAnalysis: boolean;
  autoUpdate: boolean;
  githubProxy?: string;
  locale?: string;
}

export function looksLikeGitHubTarget(value: string): boolean {
  return /^https:\/\/github\.com\//i.test(value.trim());
}

export function buildAnalysisJobPayload(form: AnalysisJobForm): Record<string, unknown> {
  const target = form.target.trim();
  const githubProxy = (form.githubProxy || "").trim();
  const locale = (form.locale || "").trim();
  return {
    action: "understand",
    target,
    full: form.fullAnalysis,
    auto_update: form.autoUpdate,
    ...(locale ? { locale } : {}),
    ...(githubProxy && looksLikeGitHubTarget(target)
      ? { github_proxy: githubProxy }
      : {}),
  };
}
