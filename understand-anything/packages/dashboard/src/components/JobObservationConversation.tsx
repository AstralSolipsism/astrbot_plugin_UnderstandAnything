import { useMemo } from "react";
import { AlertCircle, CheckCircle2, Clock3, Info, Loader2, TerminalSquare } from "lucide-react";
import { Conversation, ConversationContent, ConversationEmptyState } from "./ai-elements/conversation";
import { Message, MessageResponse } from "./ai-elements/message";
import { normalizeJobObservations, type JobObservation, type ObservableJob } from "../utils/jobObservations";

interface JobObservationConversationProps {
  job: ObservableJob;
}

function statusLabel(status: string | undefined): string {
  if (status === "running") return "运行中";
  if (status === "completed" || status === "succeeded" || status === "finished") return "完成";
  if (status === "failed") return "失败";
  if (status === "queued") return "排队";
  return "记录";
}

function levelTone(level: JobObservation["level"]): string {
  if (level === "success") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (level === "warning") return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  if (level === "error") return "border-red-500/40 bg-red-500/10 text-red-200";
  return "border-sky-500/40 bg-sky-500/10 text-sky-200";
}

function subtleLevelTone(level: JobObservation["level"]): string {
  if (level === "success") return "border-emerald-500/25 bg-emerald-500/5 text-emerald-200";
  if (level === "warning") return "border-amber-500/25 bg-amber-500/5 text-amber-200";
  if (level === "error") return "border-red-500/30 bg-red-500/10 text-red-200";
  return "border-border-subtle bg-surface/45 text-text-secondary";
}

function LevelIcon({ level, status }: { level: JobObservation["level"]; status?: string }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  if (level === "success") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (level === "warning" || level === "error") return <AlertCircle className="h-3.5 w-3.5" />;
  return <Info className="h-3.5 w-3.5" />;
}

function formatObservationTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function observationSpeech(observation: JobObservation): string {
  return observation.message
    .replace(/^AstrBot Provider 最近输出：/u, "")
    .replace(/；/gu, "\n");
}

function observationLines(observation: JobObservation): string[] {
  const lines = observationSpeech(observation)
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : [observation.title];
}

function detailCommand(details: Record<string, unknown> | undefined): string | null {
  const command = details?.command;
  return typeof command === "string" && command.trim() ? command : null;
}

function SpeechBubble({ observation, speaker }: { observation: JobObservation; speaker: string }) {
  const isError = observation.level === "error";
  const lines = observationLines(observation);
  return (
    <div className="space-y-2">
      {lines.map((line, index) => (
        <Message key={`${observation.id}-${index}`} role="assistant">
          <div className="min-w-0">
            <div className="mb-1 flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden text-[11px] text-text-muted">
              <span className={`shrink-0 whitespace-nowrap font-semibold uppercase tracking-wide ${isError ? "text-red-200" : "text-accent"}`}>
                {speaker}
              </span>
              <span className="min-w-0 truncate">{observation.stage ?? observation.title}</span>
              <span className="shrink-0 whitespace-nowrap font-mono">{formatObservationTime(observation.createdAt)}</span>
            </div>
            <MessageResponse>{line}</MessageResponse>
          </div>
        </Message>
      ))}
    </div>
  );
}

function KindLabel({ observation }: { observation: JobObservation }) {
  const label = observation.kind === "command"
    ? "命令"
    : observation.kind === "validation"
      ? "校验"
      : observation.kind === "artifact"
        ? "产物"
        : observation.kind === "success"
          ? "完成"
          : observation.kind === "error"
            ? "错误"
            : "系统";

  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${levelTone(observation.level)}`}>
      {observation.kind === "command" ? (
        <TerminalSquare className="h-3.5 w-3.5" />
      ) : (
        <LevelIcon level={observation.level} status={observation.status} />
      )}
      {label}
    </span>
  );
}

function StatusLine({ observation }: { observation: JobObservation }) {
  const command = observation.kind === "command" ? detailCommand(observation.details) : null;
  return (
    <div className="flex min-w-0 items-start gap-2 text-xs leading-5">
      <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${subtleLevelTone(observation.level)}`}>
        {observation.kind === "command" ? (
          <TerminalSquare className="h-3.5 w-3.5" />
        ) : (
          <LevelIcon level={observation.level} status={observation.status} />
        )}
      </span>
      <div className="min-w-0 flex-1 border-b border-border-subtle/70 pb-2">
        <div className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
          <KindLabel observation={observation} />
          <span className="inline-flex shrink-0 items-center rounded-full border border-border-subtle bg-root/60 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-text-muted">
            {statusLabel(observation.status)}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] whitespace-nowrap text-text-muted">
            <Clock3 className="h-3 w-3" />
            {formatObservationTime(observation.createdAt)}
          </span>
          <span className="shrink-0 whitespace-nowrap font-medium text-text-primary" title={observation.title}>
            {observation.title}
          </span>
          <span className="min-w-0 flex-1 truncate text-text-secondary" title={observation.message}>
            {observation.message}
          </span>
        </div>
        {command && (
          <code className="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap rounded border border-border-subtle bg-root px-2 py-0.5 font-mono text-[11px] text-text-muted">
            {command}
          </code>
        )}
      </div>
    </div>
  );
}

function ObservationMessage({ observation }: { observation: JobObservation }) {
  if (observation.kind === "assistant") return <SpeechBubble observation={observation} speaker="AstrBot Provider" />;
  if (observation.kind === "error") return <SpeechBubble observation={observation} speaker="Dashboard" />;
  return <StatusLine observation={observation} />;
}

export default function JobObservationConversation({ job }: JobObservationConversationProps) {
  const observations = useMemo(() => normalizeJobObservations(job), [job]);

  return (
    <Conversation className="h-[420px] rounded-md border border-border-subtle bg-root">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">任务对话流</div>
          <div className="mt-0.5 text-xs text-text-secondary">AstrBot Provider 和 SubAgent 输出会作为消息追加，命令和校验保留为紧凑事件。</div>
        </div>
        <span className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] ${levelTone(job.status === "failed" ? "error" : job.status === "succeeded" || job.status === "finished" ? "success" : "info")}`}>
          {statusLabel(job.status)}
        </span>
      </div>
      <ConversationContent className="space-y-3 p-3">
        {observations.length === 0 ? (
          <ConversationEmptyState>暂无过程观察。</ConversationEmptyState>
        ) : (
          observations.map((observation) => <ObservationMessage key={observation.id} observation={observation} />)
        )}
      </ConversationContent>
    </Conversation>
  );
}
