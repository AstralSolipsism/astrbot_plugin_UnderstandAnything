export type JobObservationKind =
  | "system"
  | "stage"
  | "command"
  | "assistant"
  | "validation"
  | "artifact"
  | "success"
  | "error";

export type JobObservationLevel = "info" | "success" | "warning" | "error";

export interface JobObservation {
  id: string;
  createdAt: string;
  kind: JobObservationKind;
  level: JobObservationLevel;
  title: string;
  message: string;
  stage?: string;
  status?: string;
  details?: Record<string, unknown>;
}

export interface ObservableJob {
  id: string;
  status: "queued" | "running" | "waiting_confirmation" | "succeeded" | "finished" | "failed" | "cancelled";
  stage: string;
  startedAt?: string;
  summary?: string;
  error?: string;
  recentLogs: string[];
  observations?: JobObservation[];
}

function stripLogTimestamp(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, "");
}

function fallbackLevel(job: ObservableJob, line: string): JobObservationLevel {
  if (/失败|错误|超时|终止/u.test(line)) return "error";
  if (/完成|成功|已生成|通过/u.test(line)) return "success";
  if (/警告|修复|跳过/u.test(line)) return "warning";
  if (job.status === "failed" && !/开始：|命令/u.test(line)) return "error";
  return "info";
}

function fallbackKind(line: string): JobObservationKind {
  if (/命令|开始：|完成：/u.test(line)) return "command";
  if (/AstrBot|Provider|SubAgent|助手/u.test(line)) return "assistant";
  if (/校验|质量/u.test(line)) return "validation";
  if (/json|fingerprints|inventory|report/u.test(line)) return "artifact";
  return "system";
}

function fallbackTitle(kind: JobObservationKind, level: JobObservationLevel): string {
  if (level === "error") return "任务失败";
  if (kind === "command") return "命令执行";
  if (kind === "assistant") return "AstrBot Provider";
  if (kind === "validation") return "产物校验";
  if (kind === "artifact") return "产物生成";
  if (kind === "success") return "任务完成";
  return "任务记录";
}

export function normalizeJobObservations(job: ObservableJob): JobObservation[] {
  if (job.observations && job.observations.length > 0) return job.observations;
  const fallbackStart = Number.isNaN(Date.parse(job.startedAt ?? ""))
    ? Date.now()
    : Date.parse(job.startedAt ?? "");

  const observations = job.recentLogs.slice(-18).map((line, index) => {
    const message = stripLogTimestamp(line);
    const kind = fallbackKind(message);
    const level = fallbackLevel(job, message);
    return {
      id: `${job.id}-log-${index}`,
      createdAt: new Date(fallbackStart + index).toISOString(),
      kind,
      level,
      title: fallbackTitle(kind, level),
      message,
      stage: job.stage,
      status: job.status === "succeeded" || job.status === "finished" ? "completed" : job.status === "failed" ? "failed" : job.status,
    } satisfies JobObservation;
  });

  if (observations.length === 0 && job.summary) {
    observations.push({
      id: `${job.id}-summary`,
      createdAt: new Date(fallbackStart).toISOString(),
      kind: job.status === "failed" ? "error" : "success",
      level: job.status === "failed" ? "error" : "success",
      title: job.status === "failed" ? "任务失败" : "任务摘要",
      message: job.error ?? job.summary,
      stage: job.stage,
      status: job.status === "succeeded" || job.status === "finished" ? "completed" : job.status,
    });
  }

  return observations;
}
