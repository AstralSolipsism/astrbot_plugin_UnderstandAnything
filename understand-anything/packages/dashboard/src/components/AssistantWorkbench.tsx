import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Bot,
  FileCode2,
  GitCompareArrows,
  Loader2,
  MessageSquare,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  assistantContextKey,
  useDashboardStore,
  type AssistantArtifact,
  type AssistantContextItem,
  type AssistantMode,
  type DashboardAssistantMessage,
} from "../store";
import {
  type ProjectRefParams,
  pluginPost,
} from "../utils/astrbotBridge";
import {
  currentBridge,
  isAstrBotPluginPageContext,
} from "../utils/pluginPageContext";
import { toUserErrorMessage } from "../utils/userErrors";
import { AssistantMarkdownRenderer } from "./assistant-markdown/AssistantMarkdownRenderer";
import {
  buildAssistantReferenceIndex,
  type AssistantReferenceIndex,
} from "./assistant-markdown/assistantReferenceIndex";

interface AssistantWorkbenchProps {
  projectId?: string;
  projectParams?: ProjectRefParams;
}

interface AssistantSourceSnippet {
  path: string;
  language?: string;
  content: string;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
}

interface AssistantRuntimeContext {
  mode?: AssistantMode;
  items?: AssistantContextItem[];
  sourceSnippets?: AssistantSourceSnippet[];
  graphSummary?: {
    nodeCount?: number;
    edgeCount?: number;
    domainNodeCount?: number;
    domainEdgeCount?: number;
  };
  diffOverlay?: {
    changedFiles?: string[];
    unmappedFiles?: string[];
  };
}

interface AssistantResponse {
  answer?: string;
  markdown?: string;
  assistantContext?: AssistantRuntimeContext;
  assistantWarnings?: string[];
}

const modeOptions: Array<{ mode: AssistantMode; label: string; icon: typeof MessageSquare }> = [
  { mode: "chat", label: "问答", icon: MessageSquare },
  { mode: "explain", label: "解释", icon: FileCode2 },
  { mode: "diff", label: "变更", icon: GitCompareArrows },
  { mode: "onboarding", label: "入门", icon: BookOpen },
];

function createMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `message-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function textMessage(
  role: DashboardAssistantMessage["role"],
  text: string,
): DashboardAssistantMessage {
  return {
    id: createMessageId(),
    role,
    parts: [{ type: "text", text }],
  };
}

function textFromMessage(message: DashboardAssistantMessage): string {
  return message.parts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function defaultPrompt(mode: AssistantMode, contextItems: AssistantContextItem[]): string {
  if (mode === "explain") {
    return contextItems.length > 0
      ? "请解释当前加入会话上下文的对象。"
      : "请解释当前项目中最核心的模块。";
  }
  if (mode === "diff") return "请分析当前变更对项目结构、关键节点和风险面的影响。";
  if (mode === "onboarding") return "请为新加入维护者生成一份项目 onboarding 文档。";
  return "";
}

function contextLabel(item: AssistantContextItem): string {
  const prefix = "graphKind" in item && item.graphKind === "domain" ? "领域 " : "";
  if (item.type === "node") return `${prefix}${item.label || item.nodeId}`;
  if (item.type === "file") return `${prefix}${item.path}`;
  if (item.type === "code-range") return `${prefix}${item.path}:${item.startLine}-${item.endLine}`;
  if (item.type === "diff-file") return item.status ? `${item.path} (${item.status})` : item.path;
  return item.label || item.layerId;
}

function contextTone(item: AssistantContextItem): string {
  if ("graphKind" in item && item.graphKind === "domain") {
    return "border-violet-500/40 bg-violet-500/10 text-violet-200";
  }
  if (item.type === "node") return "border-accent/40 bg-accent/10 text-accent";
  if (item.type === "file") return "border-sky-500/40 bg-sky-500/10 text-sky-200";
  if (item.type === "code-range") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (item.type === "diff-file") return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  return "border-violet-500/40 bg-violet-500/10 text-violet-200";
}

function firstContextTarget(items: AssistantContextItem[]): string {
  const first = items[0];
  if (!first) return "";
  if (first.type === "node") return first.nodeId;
  if ("path" in first) return first.path;
  return first.label;
}

function requestForMode({
  mode,
  text,
  contextItems,
  projectParams,
  changedFiles,
}: {
  mode: AssistantMode;
  text: string;
  contextItems: AssistantContextItem[];
  projectParams: ProjectRefParams;
  changedFiles: Array<{ path: string }>;
}): { endpoint: string; body: Record<string, unknown> } {
  const base = {
    ...projectParams,
    contextItems,
  };
  if (mode === "explain") {
    return {
      endpoint: "explain",
      body: {
        ...base,
        target: text || firstContextTarget(contextItems),
      },
    };
  }
  if (mode === "diff") {
    return {
      endpoint: "diff",
      body: {
        ...base,
        changed_files: changedFiles.map((file) => file.path),
      },
    };
  }
  if (mode === "onboarding") {
    return {
      endpoint: "onboard",
      body: base,
    };
  }
  return {
    endpoint: "chat",
    body: {
      ...base,
      query: text,
    },
  };
}

function MessageView({
  message,
  referenceIndex,
}: {
  message: DashboardAssistantMessage;
  referenceIndex: AssistantReferenceIndex;
}) {
  const isUser = message.role === "user";
  const text = textFromMessage(message);
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] rounded-lg border px-3 py-2 text-sm leading-6 ${
          isUser
            ? "border-accent/40 bg-accent/15 text-text-primary"
            : "border-border-subtle bg-root text-text-secondary"
        }`}
      >
        {!isUser && (
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase text-accent">
            <Bot className="h-3 w-3" />
            AstrBot Provider
          </div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap">{text}</div>
        ) : (
          <AssistantMarkdownRenderer referenceIndex={referenceIndex}>
            {text || " "}
          </AssistantMarkdownRenderer>
        )}
      </div>
    </div>
  );
}

function ContextTray() {
  const contextItems = useDashboardStore((s) => s.assistantContextItems);
  const removeAssistantContextItem = useDashboardStore((s) => s.removeAssistantContextItem);
  const clearAssistantContextItems = useDashboardStore((s) => s.clearAssistantContextItems);
  const changedDiffFiles = useDashboardStore((s) => s.changedDiffFiles);
  const addAssistantContextItem = useDashboardStore((s) => s.addAssistantContextItem);

  return (
    <div className="border-b border-border-subtle bg-surface px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase text-text-muted">会话上下文</div>
        {contextItems.length > 0 && (
          <button
            type="button"
            onClick={clearAssistantContextItems}
            className="inline-flex items-center gap-1 rounded border border-border-medium px-2 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary"
          >
            <Trash2 className="h-3 w-3" />
            清空
          </button>
        )}
      </div>
      <div className="flex max-h-24 flex-wrap gap-1.5 overflow-auto">
        {contextItems.length === 0 ? (
          <div className="text-xs text-text-muted">使用加入按钮或右键菜单添加会话上下文。</div>
        ) : (
          contextItems.map((item) => (
            <span
              key={assistantContextKey(item)}
              className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${contextTone(item)}`}
              title={contextLabel(item)}
            >
              <span className="truncate">{contextLabel(item)}</span>
              <button
                type="button"
                onClick={() => removeAssistantContextItem(assistantContextKey(item))}
                className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                aria-label="移除上下文"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        )}
      </div>
      {changedDiffFiles.length > 0 && (
        <div className="mt-2 border-t border-border-subtle pt-2">
          <div className="mb-1 text-[11px] font-semibold uppercase text-text-muted">变更文件</div>
          <div className="flex max-h-16 flex-wrap gap-1.5 overflow-auto">
            {changedDiffFiles.slice(0, 12).map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() =>
                  addAssistantContextItem({
                    type: "diff-file",
                    path: file.path,
                    status: file.status,
                    label: file.path,
                  })
                }
                className="max-w-full truncate rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/15"
                title={file.path}
              >
                {file.path}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RuntimeContextPanel({
  context,
  warnings,
}: {
  context: AssistantRuntimeContext | null;
  warnings: string[];
}) {
  if (!context && warnings.length === 0) return null;
  const snippets = context?.sourceSnippets ?? [];
  const selectedItems = context?.items ?? [];
  return (
    <div className="rounded-lg border border-border-subtle bg-root p-3 text-xs text-text-muted">
      <div className="mb-2 font-semibold uppercase text-text-secondary">AstrBot 上下文包</div>
      {context?.graphSummary && (
        <div className="mb-2 grid grid-cols-2 gap-2">
          <div>节点：{context.graphSummary.nodeCount ?? 0}</div>
          <div>关系：{context.graphSummary.edgeCount ?? 0}</div>
          <div>领域节点：{context.graphSummary.domainNodeCount ?? 0}</div>
          <div>领域关系：{context.graphSummary.domainEdgeCount ?? 0}</div>
        </div>
      )}
      {selectedItems.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 font-semibold text-text-secondary">已采用上下文</div>
          <div className="flex flex-wrap gap-1">
            {selectedItems.map((item) => (
              <span
                key={assistantContextKey(item)}
                className={`max-w-full truncate rounded border px-1.5 py-0.5 ${contextTone(item)}`}
                title={contextLabel(item)}
              >
                {contextLabel(item)}
              </span>
            ))}
          </div>
        </div>
      )}
      {snippets.length > 0 && (
        <div className="space-y-2">
          <div className="font-semibold text-text-secondary">源码片段</div>
          {snippets.slice(0, 3).map((snippet) => (
            <details key={`${snippet.path}:${snippet.startLine ?? 0}`} className="rounded border border-border-subtle bg-surface">
              <summary className="cursor-pointer px-2 py-1 font-mono text-[11px] text-text-secondary">
                {snippet.path}
                {snippet.startLine && snippet.endLine ? `:${snippet.startLine}-${snippet.endLine}` : ""}
                {snippet.truncated ? " · 已截断" : ""}
              </summary>
              <pre className="max-h-40 overflow-auto border-t border-border-subtle p-2 text-[11px] leading-5 text-text-secondary">
                {snippet.content}
              </pre>
            </details>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200">
          {warnings.slice(0, 3).join("；")}
        </div>
      )}
    </div>
  );
}

export default function AssistantWorkbench({
  projectId,
  projectParams,
}: AssistantWorkbenchProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [runtimeContext, setRuntimeContext] = useState<AssistantRuntimeContext | null>(null);
  const [runtimeWarnings, setRuntimeWarnings] = useState<string[]>([]);
  const [messages, setMessages] = useState<DashboardAssistantMessage[]>([]);
  const mode = useDashboardStore((s) => s.assistantMode);
  const setMode = useDashboardStore((s) => s.setAssistantMode);
  const contextItems = useDashboardStore((s) => s.assistantContextItems);
  const artifacts = useDashboardStore((s) => s.assistantArtifacts);
  const setArtifacts = useDashboardStore((s) => s.setAssistantArtifacts);
  const setStoreMessages = useDashboardStore((s) => s.setAssistantMessages);
  const setStreaming = useDashboardStore((s) => s.setAssistantStreaming);
  const changedDiffFiles = useDashboardStore((s) => s.changedDiffFiles);
  const graph = useDashboardStore((s) => s.graph);
  const domainGraph = useDashboardStore((s) => s.domainGraph);

  const referenceIndex = useMemo(
    () => buildAssistantReferenceIndex(graph, domainGraph),
    [domainGraph, graph],
  );

  useEffect(() => {
    setStoreMessages(messages);
  }, [messages, setStoreMessages]);

  useEffect(() => {
    setStreaming(pending);
  }, [pending, setStreaming]);

  async function submitMessage(event?: React.FormEvent) {
    event?.preventDefault();
    const text = input.trim() || defaultPrompt(mode, contextItems);
    if (!text || pending) return;
    const bridge = currentBridge();
    if (!bridge || !isAstrBotPluginPageContext()) {
      setError("AstrBot Plugin Page bridge 不可用，当前环境无法调用助手。");
      return;
    }

    const effectiveProjectParams =
      projectParams ?? (projectId ? ({ project_id: projectId } satisfies ProjectRefParams) : {});
    const { endpoint, body } = requestForMode({
      mode,
      text,
      contextItems,
      projectParams: effectiveProjectParams,
      changedFiles: changedDiffFiles,
    });
    const userMessage = textMessage("user", text);
    setInput("");
    setError(null);
    setRuntimeWarnings([]);
    setMessages((previous) => [...previous, userMessage]);
    setPending(true);

    try {
      const response = await pluginPost<AssistantResponse>(bridge, endpoint, body);
      const answer = response.answer ?? response.markdown ?? "AstrBot Provider 没有返回内容。";
      const assistantMessage = textMessage("assistant", answer);
      setMessages((previous) => [...previous, assistantMessage]);
      setRuntimeContext(response.assistantContext ?? null);
      setRuntimeWarnings(Array.isArray(response.assistantWarnings) ? response.assistantWarnings : []);
      setArtifacts([
        {
          id: createMessageId(),
          kind: mode,
          title: "AstrBot 上下文包",
          content: answer,
          createdAt: new Date().toISOString(),
        } satisfies AssistantArtifact,
        ...artifacts,
      ].slice(0, 6));
    } catch (err) {
      setError(toUserErrorMessage(err, "AstrBot Provider 会话失败，请稍后重试。"));
    } finally {
      setPending(false);
    }
  }

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-l border-border-subtle bg-surface">
      <div className="border-b border-border-subtle px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-heading text-sm text-text-primary">AstrBot 项目会话</div>
            <div className="mt-0.5 text-xs text-text-muted">只读分析，基于当前项目上下文回答。</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1 rounded-md bg-root p-1">
          {modeOptions.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.mode}
                type="button"
                onClick={() => setMode(item.mode)}
                className={`inline-flex items-center justify-center gap-1 rounded px-2 py-1.5 text-xs transition-colors ${
                  mode === item.mode
                    ? "bg-accent/20 text-accent"
                    : "text-text-muted hover:bg-elevated hover:text-text-primary"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <ContextTray />

      <div className="flex-1 space-y-3 overflow-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="rounded-lg border border-border-subtle bg-root p-4 text-sm text-text-muted">
            在左侧浏览项目，使用加入按钮或右键菜单添加上下文，然后在这里提问。
          </div>
        ) : (
          messages.map((message) => (
            <MessageView key={message.id} message={message} referenceIndex={referenceIndex} />
          ))
        )}
        {pending && (
          <div className="inline-flex items-center gap-2 rounded-md border border-border-subtle bg-root px-3 py-2 text-xs text-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            AstrBot Provider 正在只读分析
          </div>
        )}
        {error && (
          <div className="rounded-md border border-red-800 bg-red-950/30 p-3 text-xs text-red-200">
            {error}
          </div>
        )}
        <RuntimeContextPanel context={runtimeContext} warnings={runtimeWarnings} />
      </div>

      <form onSubmit={submitMessage} className="border-t border-border-subtle bg-surface p-3">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submitMessage();
            }
          }}
          rows={3}
          placeholder={
            mode === "chat"
              ? "询问这个项目..."
              : mode === "explain"
                ? "解释当前上下文..."
                : mode === "diff"
                  ? "分析变更影响..."
                  : "生成 onboarding..."
          }
          disabled={pending}
          className="w-full resize-none rounded-md border border-border-subtle bg-root px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-[11px] text-text-muted">
            {contextItems.length > 0 ? `${contextItems.length} 个上下文已加入` : "可直接提问，也可先加入上下文"}
          </div>
          <button
            type="submit"
            disabled={pending || (!input.trim() && !defaultPrompt(mode, contextItems))}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-root transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
            发送
          </button>
        </div>
      </form>
    </aside>
  );
}
