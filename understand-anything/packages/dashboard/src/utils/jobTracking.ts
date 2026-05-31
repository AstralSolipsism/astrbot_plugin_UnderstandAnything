import type { JobSnapshot, ProjectSummary } from "./astrbotBridge";

export const ACTIVE_JOB_STATUSES = new Set<JobSnapshot["status"]>([
  "queued",
  "running",
  "waiting_confirmation",
]);

export const TERMINAL_JOB_STATUSES = new Set<JobSnapshot["status"]>([
  "finished",
  "failed",
  "cancelled",
]);

export function isActiveJob(job: JobSnapshot | null | undefined): job is JobSnapshot {
  return Boolean(job && ACTIVE_JOB_STATUSES.has(job.status));
}

export function isTerminalJobStatus(
  status: JobSnapshot["status"] | null | undefined,
): boolean {
  return Boolean(status && TERMINAL_JOB_STATUSES.has(status));
}

export function isTerminalJob(job: JobSnapshot | null | undefined): job is JobSnapshot {
  return Boolean(job && isTerminalJobStatus(job.status));
}

export function jobProjectId(job: JobSnapshot | null | undefined): string {
  const value = job?.args?.project_id;
  return typeof value === "string" ? value : "";
}

export function jobForProject(
  project: Pick<ProjectSummary, "project_id">,
  jobs: JobSnapshot[],
): JobSnapshot | null {
  const projectJobs = jobs.filter((job) => jobProjectId(job) === project.project_id);
  return projectJobs.find(isActiveJob) ?? projectJobs[0] ?? null;
}

export function selectRecoverableJob(
  jobs: JobSnapshot[],
  currentJob?: JobSnapshot | null,
): JobSnapshot | null {
  if (isActiveJob(currentJob)) return currentJob;
  return jobs.find(isActiveJob) ?? null;
}

export function recentActivity(job: JobSnapshot): string {
  const lastLog = job.logs[job.logs.length - 1];
  if (lastLog) return lastLog;
  return job.progress?.label || job.status;
}

export function projectAnalysisTarget(project: ProjectSummary): string {
  const source = project.source ?? {};
  for (const key of ["target_url", "repo_url"] as const) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return project.path || "";
}
