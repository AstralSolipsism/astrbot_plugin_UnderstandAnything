import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function Conversation({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("relative flex min-h-0 flex-col", className)} {...props}>
      {children}
    </div>
  );
}

export function ConversationContent({ className, children, ...props }: ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [nearBottom, setNearBottom] = useState(true);

  useEffect(() => {
    if (!nearBottom) return;
    const node = ref.current;
    node?.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [children, nearBottom]);

  return (
    <div
      ref={ref}
      className={cn("min-h-0 flex-1 overflow-y-auto", className)}
      onScroll={(event) => {
        const node = event.currentTarget;
        setNearBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 80);
      }}
      {...props}
    >
      {children}
    </div>
  );
}

export function ConversationEmptyState({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex h-full items-center justify-center text-sm text-text-muted", className)} {...props}>
      {children}
    </div>
  );
}

export function ConversationScrollButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "absolute bottom-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-border-medium bg-elevated text-text-secondary shadow-sm transition-colors hover:text-text-primary",
        className,
      )}
      {...props}
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  );
}
