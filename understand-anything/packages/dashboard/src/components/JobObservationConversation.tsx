import { useMemo } from "react";
import { AlertCircle, CheckCircle2, Clock3, Info, Loader2, TerminalSquare } from "lucide-react";
import { Conversation, ConversationContent, ConversationEmptyState } from "./ai-elements/conversation";
import { Message, MessageResponse } from "./ai-elements/message";
import { normalizeJobObservations, type JobObservation, type ObservableJob } from "../utils/jobObservations";
import { useI18n } from "../i18n";

interface JobObservationConversationProps {
  job: ObservableJob;
}

type Translate = ReturnType<typeof useI18n>["t"];
type Locale = ReturnType<typeof useI18n>["locale"];

function statusLabel(status: string | undefined, t: Translate): string {
  if (status === "queued") return t("workspace.jobStatusQueued", "Queued");
  if (status === "running") return t("workspace.jobStatusRunning", "Running");
  if (status === "waiting_confirmation") {
    return t("workspace.jobStatusWaitingConfirmation", "Waiting for confirmation");
  }
  if (status === "completed" || status === "succeeded" || status === "finished") {
    return t("workspace.jobStatusFinished", "Finished");
  }
  if (status === "failed") return t("workspace.jobStatusFailed", "Failed");
  if (status === "cancelled") return t("workspace.jobStatusCancelled", "Cancelled");
  return t("workspace.jobStatusRecord", "Record");
}

function terminalJobStatus(status: string | undefined): boolean {
  return ["completed", "succeeded", "finished", "failed", "cancelled"].includes(status ?? "");
}

function effectiveObservationStatus(
  jobStatus: ObservableJob["status"],
  observation: JobObservation,
): string | undefined {
  if (observation.level === "error") return "failed";
  if (observation.level === "success") return "completed";
  if (observation.status === "running" && terminalJobStatus(jobStatus)) {
    return "completed";
  }
  return observation.status;
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

function formatObservationTime(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(locale, { hour12: false });
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

function SpeechBubble({
  locale,
  observation,
  speaker,
}: {
  locale: Locale;
  observation: JobObservation;
  speaker: string;
}) {
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
              <span className="shrink-0 whitespace-nowrap font-mono">{formatObservationTime(observation.createdAt, locale)}</span>
            </div>
            <MessageResponse>{line}</MessageResponse>
          </div>
        </Message>
      ))}
    </div>
  );
}

function kindLabel(observation: JobObservation, t: Translate): string {
  if (observation.kind === "command") return t("workspace.jobObservationCommand", "Command");
  if (observation.kind === "validation") {
    return t("workspace.jobObservationValidation", "Validation");
  }
  if (observation.kind === "artifact") return t("workspace.jobObservationArtifact", "Artifact");
  if (observation.kind === "success") return t("workspace.jobObservationSuccess", "Done");
  if (observation.kind === "error") return t("workspace.jobObservationError", "Error");
  return t("workspace.jobObservationSystem", "System");
}

function KindLabel({
  effectiveStatus,
  observation,
  t,
}: {
  effectiveStatus?: string;
  observation: JobObservation;
  t: Translate;
}) {
  const label = kindLabel(observation, t);

  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${levelTone(observation.level)}`}>
      {observation.kind === "command" ? (
        <TerminalSquare className="h-3.5 w-3.5" />
      ) : (
        <LevelIcon level={observation.level} status={effectiveStatus} />
      )}
      {label}
    </span>
  );
}

function StatusLine({
  effectiveStatus,
  locale,
  observation,
  t,
}: {
  effectiveStatus?: string;
  locale: Locale;
  observation: JobObservation;
  t: Translate;
}) {
  const command = observation.kind === "command" ? detailCommand(observation.details) : null;
  return (
    <div className="flex min-w-0 items-start gap-2 text-xs leading-5">
      <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${subtleLevelTone(observation.level)}`}>
        {observation.kind === "command" ? (
          <TerminalSquare className="h-3.5 w-3.5" />
        ) : (
          <LevelIcon level={observation.level} status={effectiveStatus} />
        )}
      </span>
      <div className="min-w-0 flex-1 border-b border-border-subtle/70 pb-2">
        <div className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
          <KindLabel observation={observation} effectiveStatus={effectiveStatus} t={t} />
          <span className="inline-flex shrink-0 items-center rounded-full border border-border-subtle bg-root/60 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-text-muted">
            {statusLabel(effectiveStatus, t)}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] whitespace-nowrap text-text-muted">
            <Clock3 className="h-3 w-3" />
            {formatObservationTime(observation.createdAt, locale)}
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

function ObservationMessage({
  jobStatus,
  locale,
  observation,
  t,
}: {
  jobStatus: ObservableJob["status"];
  locale: Locale;
  observation: JobObservation;
  t: Translate;
}) {
  const effectiveStatus = effectiveObservationStatus(jobStatus, observation);
  if (observation.kind === "assistant") {
    return (
      <SpeechBubble
        locale={locale}
        observation={observation}
        speaker={t("workspace.jobSpeakerProvider", "AstrBot Provider")}
      />
    );
  }
  if (observation.kind === "error") {
    return (
      <SpeechBubble
        locale={locale}
        observation={observation}
        speaker={t("workspace.jobSpeakerDashboard", "Dashboard")}
      />
    );
  }
  return (
    <StatusLine
      locale={locale}
      observation={observation}
      effectiveStatus={effectiveStatus}
      t={t}
    />
  );
}

export default function JobObservationConversation({ job }: JobObservationConversationProps) {
  const { locale, t } = useI18n();
  const observations = useMemo(() => normalizeJobObservations(job), [job]);

  return (
    <Conversation className="min-h-[240px] rounded-md border border-border-subtle bg-root [height:clamp(260px,38dvh,420px)]">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t("workspace.jobConversationTitle", "Task conversation")}
          </div>
          <div className="mt-0.5 text-xs text-text-secondary">
            {t(
              "workspace.jobConversationDescription",
              "Provider and SubAgent output is shown as messages; commands and validation stay compact.",
            )}
          </div>
        </div>
        <span className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] ${levelTone(job.status === "failed" ? "error" : job.status === "succeeded" || job.status === "finished" ? "success" : "info")}`}>
          {statusLabel(job.status, t)}
        </span>
      </div>
      <ConversationContent className="space-y-3 p-3">
        {observations.length === 0 ? (
          <ConversationEmptyState>
            {t("workspace.jobConversationEmpty", "No process observations yet.")}
          </ConversationEmptyState>
        ) : (
          observations.map((observation) => (
            <ObservationMessage
              key={observation.id}
              jobStatus={job.status}
              locale={locale}
              observation={observation}
              t={t}
            />
          ))
        )}
      </ConversationContent>
    </Conversation>
  );
}
