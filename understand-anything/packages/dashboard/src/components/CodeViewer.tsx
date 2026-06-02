import { useEffect, useMemo, useState } from "react";
import { Highlight, themes } from "prism-react-renderer";
import { Plus } from "lucide-react";
import { useDashboardStore } from "../store";
import { useI18n } from "../contexts/I18nContext";
import { toUserErrorMessage } from "../utils/userErrors";
import {
  type AstrBotWindow,
  type ProjectRefParams,
  pluginGet,
} from "../utils/astrbotBridge";
import { isAstrBotPluginPageContext } from "../utils/pluginPageContext";
import {
  buildCodeLineAssistantContextItem,
  buildFileAssistantContextItem,
} from "../utils/assistantContextActions";

interface CodeViewerProps {
  accessToken: string;
  projectId?: string;
  projectParams?: ProjectRefParams;
  presentation?: "sidebar" | "modal";
  onClose?: () => void;
  onExpand?: () => void;
}

interface SourceFile {
  path: string;
  language: string;
  content: string;
  sizeBytes: number;
  lineCount: number;
}

type SourceState =
  | { status: "idle" | "loading"; source: null; error: null }
  | { status: "loaded"; source: SourceFile; error: null }
  | { status: "error"; source: null; error: string };

const MULTI_PROJECT_MODE = import.meta.env.VITE_MULTI_PROJECT_MODE === "true" || import.meta.env.MODE === "multi";

function fileContentUrl(filePath: string, token: string): string {
  if (MULTI_PROJECT_MODE) {
    throw new Error("项目上下文缺失，无法读取源码。");
  }
  const params = new URLSearchParams({ token, path: filePath });
  return `/file-content.json?${params.toString()}`;
}

function fallbackLanguage(filePath: string | undefined): string {
  const ext = filePath?.split(".").pop()?.toLowerCase();
  const byExt: Record<string, string> = {
    css: "css",
    go: "go",
    html: "markup",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    ts: "typescript",
    tsx: "tsx",
    yaml: "yaml",
    yml: "yaml",
  };
  return ext ? byExt[ext] ?? "text" : "text";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function CodeViewer({
  accessToken,
  projectId,
  projectParams,
  presentation = "sidebar",
  onClose,
  onExpand,
}: CodeViewerProps) {
  const graph = useDashboardStore((s) => s.graph);
  const domainGraph = useDashboardStore((s) => s.domainGraph);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const codeViewerNodeId = useDashboardStore((s) => s.codeViewerNodeId);
  const closeCodeViewer = useDashboardStore((s) => s.closeCodeViewer);
  const addAssistantContextItem = useDashboardStore((s) => s.addAssistantContextItem);
  const activeGraph = viewMode === "domain" && domainGraph ? domainGraph : graph;
  // Files tab always builds its tree from the structural graph, so a node ID opened from
  // there may not exist in the active (domain) graph — fall back to the structural graph.
  const node =
    activeGraph?.nodes.find((n) => n.id === codeViewerNodeId) ??
    graph?.nodes.find((n) => n.id === codeViewerNodeId) ??
    null;
  const [state, setState] = useState<SourceState>({
    status: "idle",
    source: null,
    error: null,
  });
  const { t } = useI18n();

  useEffect(() => {
    if (!node?.filePath) {
      setState({ status: "error", source: null, error: "该节点没有关联的文件路径。" });
      return;
    }

    if (accessToken === "__demo__") {
      setState({
        status: "error",
        source: null,
        error: "源码预览仅在本地仪表盘服务运行时可用。",
      });
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    setState({ status: "loading", source: null, error: null });

    const bridge = (window as AstrBotWindow).AstrBotPluginPage;
    const loadSource = isAstrBotPluginPageContext() && bridge
      ? pluginGet<SourceFile>(bridge, "file-content", {
          ...(projectParams ?? (projectId ? { project_id: projectId } : {})),
          path: node.filePath,
        })
      : fetch(fileContentUrl(node.filePath, accessToken), {
          signal: controller.signal,
        }).then(async (res) => {
          const data = (await res.json()) as SourceFile | { error?: string };
          if (!res.ok) {
            throw new Error("error" in data && data.error ? data.error : "源码不可用");
          }
          return data as SourceFile;
        });

    loadSource
      .then((source) => {
        if (!disposed) setState({ status: "loaded", source, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || disposed) return;
        setState({
          status: "error",
          source: null,
          error: toUserErrorMessage(err, "源码读取失败，请稍后重试。"),
        });
      });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [accessToken, node?.filePath, projectId, projectParams]);

  const highlightedRange = useMemo(() => {
    if (!node?.lineRange) return null;
    return { start: node.lineRange[0], end: node.lineRange[1] };
  }, [node?.lineRange]);

  if (!node) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-surface">
        <p className="text-text-muted text-sm">{t.codeViewer.noFile}</p>
      </div>
    );
  }

  const source = state.source;
  const language = source?.language ?? fallbackLanguage(node.filePath);
  const lineInfo = highlightedRange
    ? `${t.codeViewer.lines} ${highlightedRange.start}-${highlightedRange.end}`
    : t.codeViewer.fullFile;
  const isModal = presentation === "modal";
  const handleClose = onClose ?? closeCodeViewer;
  const contextGraphKind = viewMode === "domain" && domainGraph?.nodes.some((candidate) => candidate.id === node.id)
    ? "domain"
    : "knowledge";

  const handleAddCurrentFile = () => {
    if (!node.filePath) return;
    addAssistantContextItem(buildFileAssistantContextItem({
      path: node.filePath,
      nodeId: node.id,
      graphKind: contextGraphKind,
    }));
  };

  const handleAddLine = (lineNumber: number) => {
    if (!node.filePath) return;
    addAssistantContextItem(buildCodeLineAssistantContextItem({
      path: node.filePath,
      lineNumber,
      nodeId: node.id,
      graphKind: contextGraphKind,
    }));
  };

  return (
    <div className="h-full w-full flex flex-col bg-surface overflow-hidden">
      <div className="flex items-start gap-3 px-4 py-3 bg-elevated border-b border-border-subtle shrink-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border"
              style={{
                color: "var(--color-node-file)",
                borderColor: "color-mix(in srgb, var(--color-node-file) 30%, transparent)",
                backgroundColor: "color-mix(in srgb, var(--color-node-file) 10%, transparent)",
              }}
            >
              {language}
            </span>
            <span className="text-[10px] text-text-muted">{lineInfo}</span>
          </div>
          <div className="text-sm font-heading text-text-primary truncate" title={node.name}>
            {node.name}
          </div>
          {node.filePath && (
            <div className="text-[11px] font-mono text-text-muted truncate mt-0.5" title={node.filePath}>
              {node.filePath}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleAddCurrentFile}
            disabled={!node.filePath}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-accent/30 px-2 py-1 text-[11px] font-semibold text-accent transition-colors hover:border-accent/60 hover:text-accent-bright disabled:cursor-not-allowed disabled:opacity-40"
            title="加入当前文件到会话上下文"
          >
            <Plus className="h-3 w-3" />
            加入当前文件
          </button>
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              className="text-text-muted hover:text-text-primary transition-colors"
              title={t.codeViewer.openLarger}
              aria-label={t.codeViewer.openLarger}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={handleClose}
            className="text-text-muted hover:text-text-primary transition-colors"
            title={isModal ? t.codeViewer.closeExpanded : t.codeViewer.closeViewer}
            aria-label={isModal ? t.codeViewer.closeExpanded : t.codeViewer.closeViewer}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto bg-root">
        {state.status === "loading" && (
          <div className="p-5 text-sm text-text-muted">{t.codeViewer.loading}</div>
        )}

        {state.status === "error" && (
          <div className="p-5">
            <div className="rounded-lg border border-border-subtle bg-elevated p-4">
              <div className="text-sm font-medium text-text-primary mb-2">{t.codeViewer.sourceUnavailable}</div>
              <p className="text-sm text-text-secondary leading-relaxed">{state.error}</p>
            </div>
          </div>
        )}

        {source && (
          <>
            <div className="px-4 py-2 border-b border-border-subtle bg-surface text-[11px] text-text-muted flex items-center justify-between">
              <span>{source.lineCount} {t.codeViewer.linesLabel}</span>
              <span>{formatBytes(source.sizeBytes)}</span>
            </div>
            <Highlight code={source.content} language={language} theme={themes.vsDark}>
              {({ className, style, tokens, getLineProps, getTokenProps }) => (
                <pre
                  className={`${className} min-w-max p-0 m-0 ${
                    isModal ? "text-xs leading-5" : "text-[11px] leading-5"
                  } font-mono`}
                  style={{ ...style, background: "transparent" }}
                >
                  {tokens.map((line, index) => {
                    const lineNumber = index + 1;
                    const isHighlighted =
                      highlightedRange !== null &&
                      lineNumber >= highlightedRange.start &&
                      lineNumber <= highlightedRange.end;
                    const lineProps = getLineProps({ line });
                    return (
                      <div
                        key={lineNumber}
                        {...lineProps}
                        className={`${lineProps.className} flex ${
                          isHighlighted ? "bg-accent/15" : "hover:bg-elevated/40"
                        }`}
                      >
                        <span className="flex w-14 shrink-0 select-none items-center justify-end gap-1 border-r border-border-subtle pr-2 text-right text-text-muted bg-surface/60">
                          <button
                            type="button"
                            onClick={() => handleAddLine(lineNumber)}
                            className="inline-flex h-4 w-4 items-center justify-center rounded border border-border-subtle text-text-muted transition-colors hover:border-accent/50 hover:text-accent"
                            title="加入该行到会话上下文"
                            aria-label={`加入第 ${lineNumber} 行到会话上下文`}
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                          <span>{lineNumber}</span>
                        </span>
                        <span className="pl-3 pr-6 whitespace-pre">
                          {line.map((token, key) => (
                            <span key={key} {...getTokenProps({ token })} />
                          ))}
                        </span>
                      </div>
                    );
                  })}
                </pre>
              )}
            </Highlight>
          </>
        )}
      </div>
    </div>
  );
}
