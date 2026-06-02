import type { ComponentProps, ReactNode } from "react";
import { CheckCircle2, Circle, CircleAlert, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type TaskStatus = "queued" | "running" | "completed" | "failed";

const statusStyles: Record<TaskStatus, string> = {
  queued: "border-border-medium bg-elevated text-text-muted",
  running: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  completed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  failed: "border-red-500/40 bg-red-500/10 text-red-200",
};

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (status === "completed") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "failed") return <CircleAlert className="h-4 w-4" />;
  return <Circle className="h-4 w-4" />;
}

export function Task({
  className,
  title,
  status = "queued",
  children,
  ...props
}: ComponentProps<"div"> & { title: ReactNode; status?: TaskStatus }) {
  return (
    <div className={cn("rounded-md border border-border-subtle bg-surface", className)} {...props}>
      <div className={cn("flex items-center gap-2 border-b border-border-subtle px-3 py-2 text-xs font-semibold", statusStyles[status])}>
        <StatusIcon status={status} />
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}

export function TaskContent({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("space-y-2 p-3 text-sm leading-6 text-text-secondary", className)} {...props}>
      {children}
    </div>
  );
}

export function TaskItem({
  className,
  status = "queued",
  children,
  ...props
}: ComponentProps<"div"> & { status?: TaskStatus }) {
  return (
    <div className={cn("flex items-start gap-2 text-xs text-text-secondary", className)} {...props}>
      <span className={cn("mt-0.5", statusStyles[status])}>
        <StatusIcon status={status} />
      </span>
      <span>{children}</span>
    </div>
  );
}
