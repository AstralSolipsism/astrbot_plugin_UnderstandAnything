import { useMemo, type ComponentProps } from "react";
import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDashboardStore } from "@/store";
import { AssistantMarkdownRenderer } from "@/components/assistant-markdown/AssistantMarkdownRenderer";
import { buildAssistantReferenceIndex } from "@/components/assistant-markdown/assistantReferenceIndex";

type MessageRole = "assistant" | "user" | "system";

export function Message({
  className,
  role = "assistant",
  children,
  ...props
}: ComponentProps<"div"> & { role?: MessageRole }) {
  const isUser = role === "user";
  return (
    <div className={cn("flex gap-3", isUser ? "justify-end" : "justify-start", className)} {...props}>
      {!isUser && (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-accent">
          <Bot className="h-4 w-4" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[92%] rounded-lg border px-3 py-2 text-sm leading-6",
          isUser
            ? "border-accent/40 bg-accent/15 text-text-primary"
            : "border-border-subtle bg-root text-text-secondary",
        )}
      >
        {children}
      </div>
      {isUser && (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border-medium bg-elevated text-text-secondary">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}

export function MessageContent({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("space-y-2", className)} {...props}>
      {children}
    </div>
  );
}

export function MessageResponse({ className, children, ...props }: Omit<ComponentProps<"div">, "children"> & { children: string }) {
  const graph = useDashboardStore((s) => s.graph);
  const domainGraph = useDashboardStore((s) => s.domainGraph);
  const referenceIndex = useMemo(
    () => buildAssistantReferenceIndex(graph, domainGraph),
    [domainGraph, graph],
  );

  return (
    <div className={cn("max-w-none text-sm", className)} {...props}>
      <AssistantMarkdownRenderer referenceIndex={referenceIndex}>{children || " "}</AssistantMarkdownRenderer>
    </div>
  );
}
