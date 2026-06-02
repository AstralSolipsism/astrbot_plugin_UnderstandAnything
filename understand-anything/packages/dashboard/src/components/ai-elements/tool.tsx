import { useState, type ComponentProps, type ReactNode } from "react";
import { ChevronDown, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

type ToolChildren = ReactNode | ((state: { open: boolean; setOpen: (open: boolean) => void }) => ReactNode);

export function Tool({
  className,
  defaultOpen = false,
  children,
  ...props
}: Omit<ComponentProps<"div">, "children"> & { defaultOpen?: boolean; children: ToolChildren }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("rounded-md border border-border-subtle bg-surface", className)} {...props}>
      {typeof children === "function" ? children({ open, setOpen }) : children}
    </div>
  );
}

export function ToolHeader({
  className,
  title,
  status,
  open,
  onToggle,
  ...props
}: Omit<ComponentProps<"button">, "title"> & {
  title: ReactNode;
  status?: ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={cn("flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-semibold text-text-secondary", className)}
      onClick={onToggle}
      {...props}
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        <Wrench className="h-4 w-4 shrink-0 text-accent" />
        <span className="truncate">{title}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-2">
        {status}
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </span>
    </button>
  );
}

export function ToolContent({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("border-t border-border-subtle p-3", className)} {...props}>
      {children}
    </div>
  );
}

export function ToolInput({ className, input, ...props }: ComponentProps<"pre"> & { input: unknown }) {
  return (
    <pre className={cn("overflow-auto whitespace-pre-wrap rounded border border-border-subtle bg-root p-2 text-[11px] leading-5 text-text-muted", className)} {...props}>
      {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
    </pre>
  );
}

export function ToolOutput({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("mt-2 text-sm leading-6 text-text-secondary", className)} {...props}>
      {children}
    </div>
  );
}
