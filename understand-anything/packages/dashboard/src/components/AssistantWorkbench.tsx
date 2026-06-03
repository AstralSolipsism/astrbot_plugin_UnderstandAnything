import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Bot,
  FileCode2,
  GitCompareArrows,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  assistantContextKey,
  useDashboardStore,
  type AssistantContextItem,
  type AssistantMode,
  type DashboardAssistantMessage,
} from "../store";
import { type ProjectRefParams } from "../utils/astrbotBridge";
import {
  currentBridge,
  isAstrBotPluginPageContext,
} from "../utils/pluginPageContext";
import { toUserErrorMessage } from "../utils/userErrors";
import {
  cancelWebChatSend,
  createWebChatSession,
  getWebChatSession,
  listWebChatSessions,
  renameWebChatSession,
  sessionDisplayName,
  startWebChatSend,
  stopWebChatSession,
  subscribeWebChatSendEvents,
  webChatHistoryToDashboardMessages,
  type WebChatSendStarted,
  type WebChatSessionSummary,
  type WebChatSseEvent,
} from "../utils/webchatClient";
import { useI18n } from "../i18n";
import { AssistantMarkdownRenderer } from "./assistant-markdown/AssistantMarkdownRenderer";
import {
  buildAssistantReferenceIndex,
  type AssistantReferenceIndex,
} from "./assistant-markdown/assistantReferenceIndex";

interface AssistantWorkbenchProps {
  projectId?: string;
  projectParams?: ProjectRefParams;
}

type TranslateFn = (key: string, fallback: string, vars?: Record<string, string | number | boolean | null | undefined>) => string;

const modeOptions: Array<{
  mode: AssistantMode;
  labelKey: string;
  fallback: string;
  icon: typeof MessageSquare;
}> = [
  { mode: "chat", labelKey: "assistant.modeChat", fallback: "问答", icon: MessageSquare },
  { mode: "explain", labelKey: "assistant.modeExplain", fallback: "解释", icon: FileCode2 },
  { mode: "diff", labelKey: "assistant.modeDiff", fallback: "变更", icon: GitCompareArrows },
  { mode: "onboarding", labelKey: "assistant.modeOnboarding", fallback: "入门", icon: BookOpen },
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

function defaultPrompt(mode: AssistantMode, contextItems: AssistantContextItem[], t: TranslateFn): string {
  if (mode === "explain") {
    return contextItems.length > 0
      ? t("assistant.defaultPromptExplainContext", "请解释当前加入会话上下文的对象。")
      : t("assistant.defaultPromptExplainProject", "请解释当前项目中最核心的模块。");
  }
  if (mode === "diff") {
    return t("assistant.defaultPromptDiff", "请分析当前变更对项目结构、关键节点和风险面的影响。");
  }
  if (mode === "onboarding") {
    return t("assistant.defaultPromptOnboarding", "请为新加入维护者生成一份项目 onboarding 文档。");
  }
  return "";
}

function contextLabel(item: AssistantContextItem, t: TranslateFn): string {
  const prefix = "graphKind" in item && item.graphKind === "domain"
    ? t("assistant.domainPrefix", "领域 ")
    : "";
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

function MessageView({
  message,
  referenceIndex,
  t,
}: {
  message: DashboardAssistantMessage;
  referenceIndex: AssistantReferenceIndex;
  t: TranslateFn;
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
            {t("assistant.providerLabel", "AstrBot Provider")}
          </div>
        )}
        <div className="space-y-2">
          {isUser ? (
            <div className="whitespace-pre-wrap">{text}</div>
          ) : (
            message.parts.map((part, index) => (
              <MessagePartView
                key={`${message.id}-part-${index}`}
                part={part}
                referenceIndex={referenceIndex}
                t={t}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function MessagePartView({
  part,
  referenceIndex,
  t,
}: {
  part: DashboardAssistantMessage["parts"][number];
  referenceIndex: AssistantReferenceIndex;
  t: TranslateFn;
}) {
  if (part.type === "text" && typeof part.text === "string") {
    return (
      <AssistantMarkdownRenderer referenceIndex={referenceIndex}>
        {part.text || " "}
      </AssistantMarkdownRenderer>
    );
  }
  if (part.type === "reasoning" && typeof part.text === "string") {
    return (
      <details className="rounded border border-border-subtle bg-surface/60 px-2 py-1 text-xs text-text-muted">
        <summary className="cursor-pointer font-semibold text-text-secondary">
          {t("assistant.reasoningLabel", "推理过程")}
        </summary>
        <div className="mt-1 whitespace-pre-wrap">{part.text}</div>
      </details>
    );
  }
  if (part.type === "tool-call" || part.type === "tool-result") {
    const label = typeof part.label === "string" ? part.label : t("assistant.toolLabel", "工具调用");
    return (
      <div className="rounded border border-border-subtle bg-surface/60 px-2 py-1 text-xs text-text-muted">
        <div className="font-semibold text-text-secondary">
          {part.type === "tool-call"
            ? t("assistant.toolCallLabel", "工具调用")
            : t("assistant.toolResultLabel", "工具结果")}
        </div>
        <div className="mt-0.5 break-all">{label}</div>
      </div>
    );
  }
  if (part.type === "attachment") {
    const filename = typeof part.filename === "string" && part.filename
      ? part.filename
      : typeof part.attachmentId === "string" && part.attachmentId
        ? part.attachmentId
        : t("assistant.attachmentUnnamed", "未命名附件");
    const attachmentType = typeof part.attachmentType === "string" ? part.attachmentType : "file";
    return (
      <div className="rounded border border-border-subtle bg-surface/60 px-2 py-1 text-xs text-text-muted">
        <div className="font-semibold text-text-secondary">
          {t("assistant.attachmentLabel", "附件")} · {attachmentType}
        </div>
        <div className="mt-0.5 break-all">{filename}</div>
      </div>
    );
  }
  if (part.type === "agent-stats") {
    return (
      <div className="rounded border border-border-subtle bg-surface/60 px-2 py-1 text-xs text-text-muted">
        <div className="font-semibold text-text-secondary">
          {t("assistant.agentStatsLabel", "运行统计")}
        </div>
        <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all">
          {JSON.stringify(part.stats ?? {}, null, 2)}
        </pre>
      </div>
    );
  }
  const partRecord = part as Record<string, unknown>;
  const label =
    typeof partRecord.label === "string" ? partRecord.label : String(partRecord.type || "part");
  return (
    <div className="rounded border border-border-subtle bg-surface/60 px-2 py-1 text-xs text-text-muted">
      <div className="font-semibold text-text-secondary">
        {t("assistant.webchatPartLabel", "WebChat 消息段")}
      </div>
      <div className="mt-0.5 break-all">{label}</div>
    </div>
  );
}

function ContextTray({ t }: { t: TranslateFn }) {
  const contextItems = useDashboardStore((s) => s.assistantContextItems);
  const removeAssistantContextItem = useDashboardStore((s) => s.removeAssistantContextItem);
  const clearAssistantContextItems = useDashboardStore((s) => s.clearAssistantContextItems);
  const changedDiffFiles = useDashboardStore((s) => s.changedDiffFiles);
  const addAssistantContextItem = useDashboardStore((s) => s.addAssistantContextItem);

  return (
    <div className="border-b border-border-subtle bg-surface px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase text-text-muted">
          {t("assistant.contextTitle", "会话上下文")}
        </div>
        {contextItems.length > 0 && (
          <button
            type="button"
            onClick={clearAssistantContextItems}
            className="inline-flex items-center gap-1 rounded border border-border-medium px-2 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary"
          >
            <Trash2 className="h-3 w-3" />
            {t("assistant.clearContext", "清空")}
          </button>
        )}
      </div>
      <div className="flex max-h-24 flex-wrap gap-1.5 overflow-auto">
        {contextItems.length === 0 ? (
          <div className="text-xs text-text-muted">
            {t("assistant.emptyContext", "使用加入按钮或右键菜单添加会话上下文。")}
          </div>
        ) : (
          contextItems.map((item) => (
            <span
              key={assistantContextKey(item)}
              className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${contextTone(item)}`}
              title={contextLabel(item, t)}
            >
              <span className="truncate">{contextLabel(item, t)}</span>
              <button
                type="button"
                onClick={() => removeAssistantContextItem(assistantContextKey(item))}
                className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                aria-label={t("assistant.removeContext", "移除上下文")}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        )}
      </div>
      {changedDiffFiles.length > 0 && (
        <div className="mt-2 border-t border-border-subtle pt-2">
          <div className="mb-1 text-[11px] font-semibold uppercase text-text-muted">
            {t("assistant.changedFiles", "变更文件")}
          </div>
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

function applyPlainStreamToMessage(
  message: DashboardAssistantMessage,
  event: WebChatSseEvent,
  t: TranslateFn,
): DashboardAssistantMessage {
  const text = typeof event.data === "string" ? event.data : "";
  if (event.chain_type === "reasoning") {
    return {
      ...message,
      parts: appendMessagePart(message.parts, { type: "reasoning", text }),
    };
  }
  if (event.chain_type === "tool_call") {
    const payload = parseJsonObject(text) ?? { raw: text };
    return {
      ...message,
      parts: appendMessagePart(message.parts, {
        type: "tool-call",
        label: toolLabel(payload, t("assistant.toolCallLabel", "工具调用")),
        payload,
      }),
    };
  }
  if (event.chain_type === "tool_call_result") {
    const payload = parseJsonObject(text) ?? { content: text };
    return {
      ...message,
      parts: appendMessagePart(message.parts, {
        type: "tool-result",
        label: toolResultLabel(payload, t("assistant.toolResultLabel", "工具结果")),
        payload,
      }),
    };
  }
  const parts = [...message.parts];
  const last = parts.at(-1);
  if (last?.type === "text" && typeof last.text === "string") {
    parts[parts.length - 1] = { ...last, text: `${last.text}${text}` };
  } else {
    parts.push({ type: "text", text });
  }
  return { ...message, parts };
}

function streamEventToDashboardPart(
  event: WebChatSseEvent,
  t: TranslateFn,
): DashboardAssistantMessage["parts"][number] | null {
  if (event.type === "agent_stats" && event.data && typeof event.data === "object") {
    return { type: "agent-stats", stats: event.data };
  }
  if (event.type === "attachment_saved" && event.data && typeof event.data === "object") {
    const data = event.data as Record<string, unknown>;
    return {
      type: "attachment",
      attachmentType: typeof data.type === "string" ? data.type : "file",
      attachmentId: typeof data.id === "string" ? data.id : "",
      filename: typeof data.filename === "string" ? data.filename : "",
    };
  }
  if (["image", "record", "file", "video"].includes(String(event.type))) {
    const attachmentType = String(event.type);
    return {
      type: "attachment",
      attachmentType,
      filename: eventDataFilename(event.data, attachmentType),
      attachmentId: "",
    };
  }
  if (event.type === "refs" && event.data && typeof event.data === "object") {
    return { type: "webchat-part", label: t("assistant.refsLabel", "引用资料"), payload: event.data };
  }
  return null;
}

function appendMessagePart(
  parts: DashboardAssistantMessage["parts"],
  part: DashboardAssistantMessage["parts"][number],
): DashboardAssistantMessage["parts"] {
  if (part.type === "text" && typeof part.text === "string") {
    const last = parts.at(-1);
    if (last?.type === "text" && typeof last.text === "string") {
      return [...parts.slice(0, -1), { ...last, text: `${last.text}${part.text}` }];
    }
  }
  return [...parts, part];
}

function eventDataFilename(data: unknown, attachmentType: string): string {
  if (typeof data !== "string") return "";
  const prefix = `[${attachmentType.toUpperCase()}]`;
  return data.replace(prefix, "").trim();
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toolLabel(payload: Record<string, unknown>, fallback: string): string {
  if (typeof payload.name === "string" && payload.name.trim()) return payload.name;
  if (typeof payload.id === "string" && payload.id.trim()) return payload.id;
  return fallback;
}

function toolResultLabel(payload: Record<string, unknown>, fallback: string): string {
  if (typeof payload.content === "string" && payload.content.trim()) return payload.content;
  if (typeof payload.tool_call_id === "string" && payload.tool_call_id.trim()) {
    return payload.tool_call_id;
  }
  return fallback;
}

export default function AssistantWorkbench({
  projectId,
  projectParams,
}: AssistantWorkbenchProps) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessions, setSessions] = useState<WebChatSessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [messages, setMessages] = useState<DashboardAssistantMessage[]>([]);
  const mode = useDashboardStore((s) => s.assistantMode);
  const setMode = useDashboardStore((s) => s.setAssistantMode);
  const contextItems = useDashboardStore((s) => s.assistantContextItems);
  const setStoreMessages = useDashboardStore((s) => s.setAssistantMessages);
  const setStreaming = useDashboardStore((s) => s.setAssistantStreaming);
  const setAssistantSessionId = useDashboardStore((s) => s.setAssistantSessionId);
  const graph = useDashboardStore((s) => s.graph);
  const domainGraph = useDashboardStore((s) => s.domainGraph);
  const currentSession = sessions.find((session) => session.session_id === currentSessionId) ?? null;
  const effectiveProjectParams =
    projectParams ?? (projectId ? ({ project_id: projectId } satisfies ProjectRefParams) : {});

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

  useEffect(() => {
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projectParams?.project_id, projectParams?.project_path, projectParams?.project_name, projectParams?.project]);

  async function loadSessions(preferredSessionId?: string | null) {
    const bridge = currentBridge();
    if (!bridge || !isAstrBotPluginPageContext()) return;
    setLoadingSessions(true);
    try {
      const payload = await listWebChatSessions(bridge);
      setSessions(payload.sessions);
      const nextSessionId =
        preferredSessionId && payload.sessions.some((session) => session.session_id === preferredSessionId)
          ? preferredSessionId
          : currentSessionId && payload.sessions.some((session) => session.session_id === currentSessionId)
            ? currentSessionId
            : payload.sessions[0]?.session_id ?? null;
      setCurrentSessionId(nextSessionId);
      setAssistantSessionId(nextSessionId);
      if (nextSessionId) {
        await loadSessionHistory(nextSessionId);
      } else {
        setMessages([]);
      }
    } catch (err) {
      setError(toUserErrorMessage(err, t("assistant.errorLoadSessions", "读取 WebChat 会话失败。")));
    } finally {
      setLoadingSessions(false);
    }
  }

  async function loadSessionHistory(sessionId: string) {
    const bridge = currentBridge();
    if (!bridge || !isAstrBotPluginPageContext()) return;
    const payload = await getWebChatSession(bridge, sessionId);
    setMessages(webChatHistoryToDashboardMessages(payload.history));
    setCurrentSessionId(payload.session.session_id);
    setAssistantSessionId(payload.session.session_id);
    setRenameValue(sessionDisplayName(payload.session));
  }

  async function createSession() {
    const bridge = currentBridge();
    if (!bridge || !isAstrBotPluginPageContext()) {
      setError(t("assistant.bridgeUnavailableCreate", "AstrBot Plugin Page bridge 不可用，当前环境无法创建会话。"));
      return;
    }
    setError(null);
    try {
      const session = await createWebChatSession(bridge, {
        display_name: "Understand Anything",
        projectParams: effectiveProjectParams,
        contextItems,
      });
      setSessions((previous) => [session, ...previous.filter((item) => item.session_id !== session.session_id)]);
      await loadSessionHistory(session.session_id);
    } catch (err) {
      setError(toUserErrorMessage(err, t("assistant.errorCreateSession", "创建 WebChat 会话失败。")));
    }
  }

  async function saveSessionName() {
    const bridge = currentBridge();
    if (!bridge || !currentSessionId) return;
    const nextName = renameValue.trim();
    if (!nextName) return;
    try {
      const session = await renameWebChatSession(bridge, currentSessionId, nextName);
      setSessions((previous) =>
        previous.map((item) => (item.session_id === session.session_id ? { ...item, ...session } : item)),
      );
      setRenaming(false);
    } catch (err) {
      setError(toUserErrorMessage(err, t("assistant.errorRenameSession", "重命名 WebChat 会话失败。")));
    }
  }

  async function stopCurrentSession() {
    const bridge = currentBridge();
    if (!bridge || !currentSessionId) return;
    try {
      if (currentRequestId) {
        await cancelWebChatSend(bridge, currentRequestId, currentSessionId);
        setCurrentRequestId(null);
      } else {
        await stopWebChatSession(bridge, currentSessionId);
      }
      setPending(false);
    } catch (err) {
      setError(toUserErrorMessage(err, t("assistant.errorStopSession", "停止 WebChat 会话失败。")));
    }
  }

  function applyStreamEvent(event: WebChatSseEvent, assistantMessageId: string) {
    if (event.type === "session_id" && typeof event.session_id === "string") {
      setCurrentSessionId(event.session_id);
      setAssistantSessionId(event.session_id);
      return;
    }
    if (event.type === "plain" && typeof event.data === "string") {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantMessageId
            ? applyPlainStreamToMessage(message, event, t)
            : message,
        ),
      );
      return;
    }
    const part = streamEventToDashboardPart(event, t);
    if (part) {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantMessageId
            ? { ...message, parts: appendMessagePart(message.parts, part) }
            : message,
        ),
      );
      return;
    }
    if (event.type === "error") {
      setError(toUserErrorMessage(event.data, t("assistant.errorStream", "WebChat 会话返回错误。")));
    }
  }

  async function submitMessage(event?: React.FormEvent) {
    event?.preventDefault();
    const text = input.trim() || defaultPrompt(mode, contextItems, t);
    if (!text || pending) return;
    const bridge = currentBridge();
    if (!bridge || !isAstrBotPluginPageContext()) {
      setError(t("assistant.bridgeUnavailableCall", "AstrBot Plugin Page bridge 不可用，当前环境无法调用助手。"));
      return;
    }
    if (!bridge.subscribeSSE) {
      setError(t("assistant.sseUnavailable", "AstrBot Plugin Page SSE bridge 不可用，当前环境无法调用 WebChat。"));
      return;
    }

    const userMessage = textMessage("user", text);
    const assistantMessage = textMessage("assistant", "");
    setInput("");
    setError(null);
    setMessages((previous) => [...previous, userMessage, assistantMessage]);
    setPending(true);

    let started: WebChatSendStarted | null = null;
    let shouldCleanupStartedSend = false;
    try {
      started = await startWebChatSend(bridge, {
        ...effectiveProjectParams,
        session_id: currentSessionId ?? undefined,
        message: text,
        contextItems,
      });
      const requestId = started.request_id;
      const sessionId = started.session_id;
      shouldCleanupStartedSend = true;
      setCurrentRequestId(requestId);
      setCurrentSessionId(sessionId);
      setAssistantSessionId(sessionId);
      await new Promise<void>((resolve, reject) => {
        let subscriptionId: string | null = null;
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (subscriptionId && bridge.unsubscribeSSE) {
            void bridge.unsubscribeSSE(subscriptionId);
          }
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        subscribeWebChatSendEvents(bridge, requestId, {
          onOpen: () => {
            shouldCleanupStartedSend = true;
          },
          onMessage: (streamEvent) => {
            applyStreamEvent(streamEvent, assistantMessage.id);
            if (streamEvent.type === "end" || streamEvent.type === "error") {
              finish(streamEvent.type === "error" ? streamEvent.data : undefined);
            }
          },
          onError: () => finish(new Error(t("assistant.sseInterrupted", "WebChat SSE 连接中断。"))),
        })
          .then((id) => {
            subscriptionId = id;
            if (settled && bridge.unsubscribeSSE) {
              void bridge.unsubscribeSSE(subscriptionId);
            }
          })
          .catch(finish);
      });
      shouldCleanupStartedSend = false;
      await loadSessions(sessionId);
    } catch (err) {
      if (started && shouldCleanupStartedSend) {
        await cancelWebChatSend(bridge, started.request_id, started.session_id).catch(() => undefined);
      }
      setError(toUserErrorMessage(err, t("assistant.errorSend", "WebChat 会话失败，请稍后重试。")));
    } finally {
      setCurrentRequestId(null);
      setPending(false);
    }
  }

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-l border-border-subtle bg-surface">
      <div className="border-b border-border-subtle px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-heading text-sm text-text-primary">
              {t("assistant.title", "AstrBot WebChat")}
            </div>
            <div className="mt-0.5 truncate text-xs text-text-muted">
              {currentSession
                ? sessionDisplayName(currentSession)
                : loadingSessions
                  ? t("assistant.loadingSessions", "正在读取会话")
                  : t("assistant.newSession", "新会话")}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void createSession()}
              className="inline-flex h-8 w-8 items-center justify-center rounded border border-border-medium text-text-muted transition-colors hover:text-text-primary"
              title={t("assistant.newSessionAction", "新建会话")}
              aria-label={t("assistant.newSessionAction", "新建会话")}
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (!currentSession) return;
                setRenameValue(sessionDisplayName(currentSession));
                setRenaming(true);
              }}
              disabled={!currentSession}
              className="inline-flex h-8 w-8 items-center justify-center rounded border border-border-medium text-text-muted transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              title={t("assistant.renameSession", "重命名会话")}
              aria-label={t("assistant.renameSession", "重命名会话")}
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void stopCurrentSession()}
              disabled={!currentSessionId || !pending}
              className="inline-flex h-8 w-8 items-center justify-center rounded border border-border-medium text-text-muted transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              title={t("assistant.stopSession", "停止会话")}
              aria-label={t("assistant.stopSession", "停止会话")}
            >
              <Square className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="mt-3">
          <select
            value={currentSessionId ?? ""}
            onChange={(event) => {
              const nextSessionId = event.target.value;
              if (nextSessionId) void loadSessionHistory(nextSessionId);
            }}
            disabled={loadingSessions || pending}
            className="w-full rounded-md border border-border-subtle bg-root px-2 py-1.5 text-xs text-text-primary outline-none transition-colors focus:border-accent disabled:opacity-60"
            aria-label={t("assistant.selectSession", "选择 WebChat 会话")}
          >
            <option value="">{t("assistant.newSession", "新会话")}</option>
            {sessions.map((session) => (
              <option key={session.session_id} value={session.session_id}>
                {sessionDisplayName(session)}
              </option>
            ))}
          </select>
        </div>
        {renaming && (
          <form
            className="mt-2 flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void saveSessionName();
            }}
          >
            <input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              className="min-w-0 flex-1 rounded border border-border-subtle bg-root px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
              aria-label={t("assistant.sessionName", "会话名称")}
            />
            <button
              type="submit"
              className="rounded bg-accent px-2 py-1 text-xs font-semibold text-root"
            >
              {t("common.save", "保存")}
            </button>
            <button
              type="button"
              onClick={() => setRenaming(false)}
              className="rounded border border-border-medium px-2 py-1 text-xs text-text-muted"
            >
              {t("common.cancel", "取消")}
            </button>
          </form>
        )}
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
                {t(item.labelKey, item.fallback)}
              </button>
            );
          })}
        </div>
      </div>

      <ContextTray t={t} />

      <div className="flex-1 space-y-3 overflow-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="rounded-lg border border-border-subtle bg-root p-4 text-sm text-text-muted">
            {t("assistant.emptyMessages", "在左侧浏览项目，使用加入按钮或右键菜单添加上下文，然后在这里提问。")}
          </div>
        ) : (
          messages.map((message) => (
            <MessageView key={message.id} message={message} referenceIndex={referenceIndex} t={t} />
          ))
        )}
        {pending && (
          <div className="inline-flex items-center gap-2 rounded-md border border-border-subtle bg-root px-3 py-2 text-xs text-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("assistant.pending", "AstrBot Provider 正在只读分析")}
          </div>
        )}
        {error && (
          <div className="rounded-md border border-red-800 bg-red-950/30 p-3 text-xs text-red-200">
            {error}
          </div>
        )}
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
              ? t("assistant.placeholderChat", "询问这个项目...")
              : mode === "explain"
                ? t("assistant.placeholderExplain", "解释当前上下文...")
                : mode === "diff"
                  ? t("assistant.placeholderDiff", "分析变更影响...")
                  : t("assistant.placeholderOnboarding", "生成 onboarding...")
          }
          disabled={pending}
          className="w-full resize-none rounded-md border border-border-subtle bg-root px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-[11px] text-text-muted">
            {contextItems.length > 0
              ? t("assistant.contextCount", "{count} 个上下文已加入", { count: contextItems.length })
              : t("assistant.noContextHint", "可直接提问，也可先加入上下文")}
          </div>
          <button
            type="submit"
            disabled={pending || (!input.trim() && !defaultPrompt(mode, contextItems, t))}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-root transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
            {t("assistant.send", "发送")}
          </button>
        </div>
      </form>
    </aside>
  );
}
