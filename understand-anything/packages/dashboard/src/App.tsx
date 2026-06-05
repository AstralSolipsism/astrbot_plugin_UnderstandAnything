import { useEffect, useState, useMemo, useCallback, lazy, Suspense } from "react";
import { validateGraph } from "@understand-anything/core/schema";
import type { GraphIssue } from "@understand-anything/core/schema";
import { useDashboardStore } from "./store";
import GraphView from "./components/GraphView";
import DomainGraphView from "./components/DomainGraphView";
import KnowledgeGraphView from "./components/KnowledgeGraphView";
import SearchBar from "./components/SearchBar";
import NodeInfo from "./components/NodeInfo";
import LayerLegend from "./components/LayerLegend";
import DiffToggle from "./components/DiffToggle";
import FilterPanel from "./components/FilterPanel";
import ExportMenu from "./components/ExportMenu";
import PersonaSelector from "./components/PersonaSelector";
import ProjectOverview from "./components/ProjectOverview";
import FileExplorer from "./components/FileExplorer";
import WarningBanner from "./components/WarningBanner";
import TokenGate from "./components/TokenGate";
import MobileLayout from "./components/MobileLayout";
import AstrBotWorkspace from "./components/AstrBotWorkspace";
import AssistantWorkbench from "./components/AssistantWorkbench";
import { useIsMobile } from "./hooks/useIsMobile";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import type { KeyboardShortcut } from "./hooks/useKeyboardShortcuts";
import { useI18n } from "./i18n";
import { I18nProvider as GraphI18nProvider } from "./contexts/I18nContext.tsx";
import { ThemeProvider } from "./themes/index.ts";
import { ThemePicker } from "./components/ThemePicker.tsx";
import type { ThemeConfig } from "./themes/index.ts";
import {
  type AstrBotWindow,
  type ProjectRefParams,
  describeGraphLoadError,
  hasProjectRef,
  pluginGet,
  projectParamsFromSearch,
} from "./utils/astrbotBridge";
import { getStorageItem, safeReplaceState, setStorageItem } from "./utils/safeBrowser";
import {
  currentBridge,
  ensureAstrBotPluginPageBridge,
  isAstrBotPluginPageContext,
} from "./utils/pluginPageContext";

// Lazy-load heavy / optional components so they ship in separate chunks.
const CodeViewer = lazy(() => import("./components/CodeViewer"));
const LearnPanel = lazy(() => import("./components/LearnPanel"));
const PathFinderModal = lazy(() => import("./components/PathFinderModal"));
const KeyboardShortcutsHelp = lazy(
  () => import("./components/KeyboardShortcutsHelp"),
);

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";
const SESSION_TOKEN_KEY = "understand-anything-token";
type SidebarTab = "info" | "files";
type JsonResponseLike = { ok: boolean; json: () => Promise<unknown> };

function endpointForDataFile(fileName: string): string {
  const endpoints: Record<string, string> = {
    "knowledge-graph.json": "graph",
    "domain-graph.json": "domain-graph",
    "meta.json": "meta",
    "diff-overlay.json": "diff-overlay",
  };
  return endpoints[fileName] ?? fileName;
}

async function loadDataFile(
  fileName: string,
  token: string | null,
  projectParams?: ProjectRefParams,
): Promise<JsonResponseLike> {
  const bridge = (window as AstrBotWindow).AstrBotPluginPage;
  if (isAstrBotPluginPageContext() && bridge) {
    try {
      const data = await pluginGet<unknown>(
        bridge,
        endpointForDataFile(fileName),
        projectParams ?? projectParamsFromSearch(window.location.search),
      );
      return { ok: true, json: async () => data };
    } catch (error) {
      return {
        ok: false,
        json: async () => ({
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
  return fetch(dataUrl(fileName, token));
}

function replaceProjectSearch(projectParams: ProjectRefParams | undefined): void {
  const params = new URLSearchParams(window.location.search);
  for (const key of ["project_id", "project_name", "project_path", "project", "path", "view"]) {
    params.delete(key);
  }
  if (projectParams) {
    for (const key of ["project_id", "project_name", "project_path", "project"] as const) {
      const value = projectParams[key];
      if (value) params.set(key, value);
    }
    if (projectParams.view) params.set("view", projectParams.view);
  }
  const search = params.toString();
  const nextUrl =
    window.location.pathname + (search ? `?${search}` : "") + window.location.hash;
  safeReplaceState(nextUrl);
}

/** Resolve data file URL — in demo mode, use env var URLs; otherwise use local paths with token. */
function dataUrl(fileName: string, token: string | null): string {
  if (DEMO_MODE) {
    const envMap: Record<string, string | undefined> = {
      "knowledge-graph.json": import.meta.env.VITE_GRAPH_URL,
      "domain-graph.json": import.meta.env.VITE_DOMAIN_GRAPH_URL,
      "meta.json": import.meta.env.VITE_META_URL,
      "diff-overlay.json": import.meta.env.VITE_DIFF_OVERLAY_URL,
    };
    const url = envMap[fileName];
    if (url) return url;
  }
  const path = `/${fileName}`;
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

/**
 * Resolve the access token from the URL query string or safe browser storage.
 * If found in the URL, persist it when storage is available and strip the param.
 */
function resolveInitialToken(): string | null {
  if (isAstrBotPluginPageContext()) return "__astrbot__";
  if (DEMO_MODE) return "__demo__";
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token");
  if (urlToken) {
    setStorageItem("session", SESSION_TOKEN_KEY, urlToken);
    // Clean the URL
    params.delete("token");
    const cleanSearch = params.toString();
    const newUrl =
      window.location.pathname + (cleanSearch ? `?${cleanSearch}` : "") + window.location.hash;
    safeReplaceState(newUrl);
    return urlToken;
  }
  return getStorageItem("session", SESSION_TOKEN_KEY);
}

function App() {
  const { t } = useI18n();
  const [pluginBridge, setPluginBridge] = useState(() => currentBridge());
  const [bridgeLoading, setBridgeLoading] = useState(
    () => isAstrBotPluginPageContext() && !currentBridge(),
  );
  const [accessToken, setAccessToken] = useState<string | null>(resolveInitialToken);
  const [astrBotProjectParams, setAstrBotProjectParams] = useState<
    ProjectRefParams | undefined
  >(() => projectParamsFromSearch(window.location.search));

  useEffect(() => {
    if (!isAstrBotPluginPageContext() || pluginBridge) {
      setBridgeLoading(false);
      return;
    }
    let disposed = false;
    setBridgeLoading(true);
    ensureAstrBotPluginPageBridge().then((loadedBridge) => {
      if (disposed) {
        return;
      }
      setPluginBridge(loadedBridge ?? currentBridge());
      setBridgeLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [pluginBridge]);

  const handleTokenValid = useCallback((token: string) => {
    setStorageItem("session", SESSION_TOKEN_KEY, token);
    setAccessToken(token);
  }, []);

  const openAstrBotProject = useCallback((projectParams: ProjectRefParams) => {
    replaceProjectSearch(projectParams);
    setAstrBotProjectParams(projectParams);
  }, []);

  const openAstrBotWorkspace = useCallback(() => {
    replaceProjectSearch(undefined);
    setAstrBotProjectParams(undefined);
  }, []);

  if (isAstrBotPluginPageContext()) {
    const bridge = pluginBridge ?? (window as AstrBotWindow).AstrBotPluginPage;
    if (!bridge || !hasProjectRef(astrBotProjectParams)) {
      return (
        <ThemeProvider metaTheme={null}>
          {bridge ? (
            <AstrBotWorkspace bridge={bridge} onOpenProject={openAstrBotProject} />
          ) : (
            <div className="h-screen w-screen flex items-center justify-center bg-root text-text-primary">
              <p className="text-sm text-text-muted">
                {bridgeLoading
                  ? t("app.bridgeConnecting", "Connecting to AstrBot Plugin Page...")
                  : t(
                      "app.bridgeUnavailable",
                      "AstrBot Plugin Page bridge is unavailable.",
                    )}
              </p>
            </div>
          )}
        </ThemeProvider>
      );
    }
    return (
      <Dashboard
        accessToken="__astrbot__"
        projectParams={astrBotProjectParams}
        onBackToWorkspace={openAstrBotWorkspace}
      />
    );
  }

  // In demo mode, skip token gate entirely
  if (DEMO_MODE) {
    return <Dashboard accessToken="__demo__" />;
  }

  // Show the token gate when no token is available
  if (accessToken === null) {
    return <TokenGate onTokenValid={handleTokenValid} />;
  }

  return <Dashboard accessToken={accessToken} />;
}

interface DashboardProps {
  accessToken: string;
  projectParams?: ProjectRefParams;
  onBackToWorkspace?: () => void;
}

function Dashboard({
  accessToken,
  projectParams,
  onBackToWorkspace,
}: DashboardProps) {
  const { locale, t } = useI18n();
  const graph = useDashboardStore((s) => s.graph);
  const setGraph = useDashboardStore((s) => s.setGraph);
  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);
  const tourActive = useDashboardStore((s) => s.tourActive);
  const persona = useDashboardStore((s) => s.persona);
  const codeViewerOpen = useDashboardStore((s) => s.codeViewerOpen);
  const codeViewerExpanded = useDashboardStore((s) => s.codeViewerExpanded);
  const expandCodeViewer = useDashboardStore((s) => s.expandCodeViewer);
  const collapseCodeViewer = useDashboardStore((s) => s.collapseCodeViewer);
  const setDiffOverlay = useDashboardStore((s) => s.setDiffOverlay);
  const pathFinderOpen = useDashboardStore((s) => s.pathFinderOpen);
  const togglePathFinder = useDashboardStore((s) => s.togglePathFinder);
  const nodeTypeFilters = useDashboardStore((s) => s.nodeTypeFilters);
  const toggleNodeTypeFilter = useDashboardStore((s) => s.toggleNodeTypeFilter);
  const detailLevel = useDashboardStore((s) => s.detailLevel);
  const setDetailLevel = useDashboardStore((s) => s.setDetailLevel);
  const showFunctionsInClassView = useDashboardStore((s) => s.showFunctionsInClassView);
  const toggleShowFunctionsInClassView = useDashboardStore((s) => s.toggleShowFunctionsInClassView);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [graphIssues, setGraphIssues] = useState<GraphIssue[]>([]);
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [metaTheme, setMetaTheme] = useState<ThemeConfig | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("info");
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const setViewMode = useDashboardStore((s) => s.setViewMode);
  const isKnowledgeGraph = useDashboardStore((s) => s.isKnowledgeGraph);
  const domainGraph = useDashboardStore((s) => s.domainGraph);
  const setDomainGraph = useDashboardStore((s) => s.setDomainGraph);
  const layoutIssues = useDashboardStore((s) => s.layoutIssues);
  const isMobile = useIsMobile();
  // Schema issues + ELK layout issues share the WarningBanner — graph-load
  // problems and dashboard rendering problems are equally surfaced.
  const allIssues = useMemo(
    () => [...graphIssues, ...layoutIssues],
    [graphIssues, layoutIssues],
  );
  const currentProjectId =
    projectParams?.project_id ??
    projectParams?.project ??
    projectParams?.project_name ??
    projectParams?.project_path;
  const showAssistant =
    accessToken === "__astrbot__" && hasProjectRef(projectParams) && Boolean(currentProjectId);

  useEffect(() => {
    if (accessToken === "__astrbot__" && !hasProjectRef(projectParams)) return;
    loadDataFile("meta.json", accessToken, projectParams)
      .then((r) => (r.ok ? r.json() : null))
      .then((meta) => {
        const theme = (meta as { theme?: ThemeConfig } | null)?.theme;
        if (theme) setMetaTheme(theme);
      })
      .catch(() => {});
  }, [accessToken, projectParams]);

  useEffect(() => {
    if (selectedNodeId) setSidebarTab("info");
  }, [selectedNodeId]);

  // Define keyboard shortcuts
  const shortcuts = useMemo<KeyboardShortcut[]>(
    () => [
      // Help
      {
        key: "?",
        shiftKey: true,
        description: t("shortcut.showHelp", "Show keyboard shortcuts help"),
        action: () => setShowKeyboardHelp((prev) => !prev),
        category: t("shortcut.general", "General"),
      },
      // Navigation
      {
        key: "Escape",
        description: t("shortcut.closePanels", "Close panels or dialogs"),
        action: () => {
          // Read from store at invocation time to avoid stale closures
          const state = useDashboardStore.getState();
          if (state.pathFinderOpen) {
            state.togglePathFinder();
          } else if (state.filterPanelOpen) {
            state.toggleFilterPanel();
          } else if (state.exportMenuOpen) {
            state.toggleExportMenu();
          } else if (state.codeViewerExpanded) {
            state.collapseCodeViewer();
          } else if (state.codeViewerOpen) {
            state.closeCodeViewer();
          } else if (state.selectedNodeId) {
            state.selectNode(null);
          } else if (state.navigationLevel === "layer-detail") {
            state.navigateToOverview();
          } else if (state.tourActive) {
            state.stopTour();
          } else {
            setShowKeyboardHelp(false);
          }
        },
        category: t("shortcut.navigation", "Navigation"),
      },
      {
        key: "/",
        description: t("shortcut.focusSearch", "Focus search input"),
        action: () => {
          const searchInput = document.querySelector<HTMLInputElement>(
            '[data-search-input="true"]'
          );
          searchInput?.focus();
        },
        category: t("shortcut.navigation", "Navigation"),
      },
      // Tour controls
      {
        key: "ArrowRight",
        description: t("shortcut.nextTour", "Next tour step"),
        action: () => {
          const state = useDashboardStore.getState();
          if (state.tourActive) {
            state.nextTourStep();
          }
        },
        category: t("shortcut.tour", "Tour"),
      },
      {
        key: "ArrowLeft",
        description: t("shortcut.previousTour", "Previous tour step"),
        action: () => {
          const state = useDashboardStore.getState();
          if (state.tourActive) {
            state.prevTourStep();
          }
        },
        category: t("shortcut.tour", "Tour"),
      },
      // View toggles
      {
        key: "d",
        description: t("shortcut.toggleDiff", "Toggle diff overlay"),
        action: () => {
          const state = useDashboardStore.getState();
          state.toggleDiffMode();
        },
        category: t("shortcut.view", "View"),
      },
      {
        key: "f",
        description: t("shortcut.toggleFilter", "Toggle filter panel"),
        action: () => {
          const state = useDashboardStore.getState();
          state.toggleFilterPanel();
        },
        category: t("shortcut.view", "View"),
      },
      {
        key: "e",
        description: t("shortcut.toggleExport", "Open export menu"),
        action: () => {
          const state = useDashboardStore.getState();
          state.toggleExportMenu();
        },
        category: t("shortcut.view", "View"),
      },
      {
        key: "p",
        description: t("shortcut.openPath", "Open dependency path finder"),
        action: () => {
          const state = useDashboardStore.getState();
          state.togglePathFinder();
        },
        category: t("shortcut.view", "View"),
      },
    ],
    [t]
  );

  // Register keyboard shortcuts
  useKeyboardShortcuts(shortcuts);

  useEffect(() => {
    if (accessToken === "__astrbot__" && !hasProjectRef(projectParams)) {
      setLoadError(t("app.selectProjectBeforeGraph", "Select a project before loading a graph."));
      return;
    }
    setLoadError(null);
    loadDataFile("knowledge-graph.json", accessToken, projectParams)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(describeGraphLoadError(await res.json(), t));
        }
        return res.json();
      })
      .then((data: unknown) => {
        const result = validateGraph(data);
        if (result.success && result.data) {
          setGraph(result.data);
          setGraphIssues(result.issues);
          // Auto-detect knowledge graph kind
          if ((data as Record<string, unknown>).kind === "knowledge") {
            setViewMode("knowledge");
            useDashboardStore.getState().setIsKnowledgeGraph(true);
          }
          for (const issue of result.issues) {
            if (issue.level === "auto-corrected") {
              console.warn(`[graph] auto-corrected: ${issue.message}`);
            } else if (issue.level === "dropped") {
              console.error(`[graph] dropped: ${issue.message}`);
            }
          }
        } else if (result.fatal) {
          console.error("Knowledge graph validation failed:", result.fatal);
          setLoadError(
            t("app.invalidGraph", "Graph file is missing nodes/edges arrays.") +
              ` ${result.fatal}`,
          );
        } else {
          console.error("Knowledge graph validation failed: unknown error");
          setLoadError(t("app.invalidGraphUnknown", "Graph file is missing required data."));
        }
      })
      .catch((err) => {
        console.error("Failed to load knowledge graph:", err);
        setLoadError(
          t("app.failedLoadGraph", "Failed to load graph: {error}", {
            error: describeGraphLoadError(err, t),
          }),
        );
      });
  }, [accessToken, projectParams, setGraph, setViewMode, t]);

  useEffect(() => {
    if (accessToken === "__astrbot__" && !hasProjectRef(projectParams)) return;
    loadDataFile("diff-overlay.json", accessToken, projectParams)
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data: unknown) => {
        if (
          data &&
          typeof data === "object" &&
          "changedNodeIds" in data &&
          "affectedNodeIds" in data &&
          Array.isArray((data as Record<string, unknown>).changedNodeIds) &&
          Array.isArray((data as Record<string, unknown>).affectedNodeIds)
        ) {
          const d = data as { changedNodeIds: string[]; affectedNodeIds: string[] };
          if (d.changedNodeIds.length > 0) {
            setDiffOverlay(d.changedNodeIds, d.affectedNodeIds);
          }
        }
      })
      .catch(() => {
        // Silently ignore - diff overlay is optional
      });
  }, [accessToken, projectParams, setDiffOverlay]);

  useEffect(() => {
    if (accessToken === "__astrbot__" && !hasProjectRef(projectParams)) return;
    loadDataFile("domain-graph.json", accessToken, projectParams)
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data: unknown) => {
        if (!data) return;
        const result = validateGraph(data);
        if (result.success && result.data) {
          setDomainGraph(result.data);
          if (projectParams?.view === "domain") {
            setViewMode("domain");
          }
        } else if (result.fatal) {
          console.warn(`[domain-graph] validation failed: ${result.fatal}`);
        }
      })
      .catch(() => {
        // Keep the graph view usable; project/workspace status surfaces incomplete analysis.
      });
  }, [accessToken, projectParams, setDomainGraph, setViewMode]);

  // Determine sidebar content
  // NodeInfo always takes priority when a node is selected.
  // Learn mode adds LearnPanel below it; otherwise ProjectOverview shows when idle.
  const isLearnMode = tourActive || persona === "junior";
  const infoSidebarContent = (
    <>
      {selectedNodeId && <NodeInfo />}
      {isLearnMode && (
        <Suspense fallback={null}>
          <LearnPanel />
        </Suspense>
      )}
      {!selectedNodeId && !isLearnMode && <ProjectOverview />}
    </>
  );

  const sidebarContent = (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-1 p-2 border-b border-border-subtle bg-surface shrink-0">
        {(["info", "files"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setSidebarTab(tab)}
            className={`flex-1 px-3 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider transition-colors ${
              sidebarTab === tab
                ? "bg-accent/15 text-accent"
                : "text-text-muted hover:text-text-primary hover:bg-elevated"
            }`}
          >
            {tab === "info" ? t("common.info", "Info") : t("common.files", "Files")}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setLeftSidebarCollapsed(true)}
          className="ml-1 rounded-md border border-border-subtle px-2 py-1.5 text-xs text-text-muted transition-colors hover:text-text-primary"
          title="折叠左侧栏"
          aria-label="折叠左侧栏"
        >
          &lt;
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {sidebarTab === "files" ? <FileExplorer /> : infoSidebarContent}
      </div>
    </div>
  );

  const collapsedSidebarContent = (
    <div className="flex h-full flex-col items-center gap-2 bg-surface p-2">
      <button
        type="button"
        onClick={() => setLeftSidebarCollapsed(false)}
        className="rounded-md border border-border-subtle px-2 py-1 text-xs text-text-muted transition-colors hover:text-text-primary"
        title="展开左侧栏"
        aria-label="展开左侧栏"
      >
        &gt;
      </button>
      <div className="h-px w-full bg-border-subtle" />
      {(["info", "files"] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => {
            setSidebarTab(tab);
            setLeftSidebarCollapsed(false);
          }}
          className={`h-8 w-8 rounded-md text-[11px] font-semibold transition-colors ${
            sidebarTab === tab
              ? "bg-accent/15 text-accent"
              : "text-text-muted hover:bg-elevated hover:text-text-primary"
          }`}
          title={tab === "info" ? t("common.info", "Info") : t("common.files", "Files")}
          aria-label={tab === "info" ? t("common.info", "Info") : t("common.files", "Files")}
        >
          {tab === "info" ? "I" : "F"}
        </button>
      ))}
    </div>
  );

  if (isMobile) {
    return (
      <GraphI18nProvider language={locale}>
        <ThemeProvider metaTheme={metaTheme}>
          <MobileLayout
            accessToken={accessToken}
            projectId={currentProjectId}
            onBackToProjects={onBackToWorkspace}
            showKeyboardHelp={showKeyboardHelp}
            setShowKeyboardHelp={setShowKeyboardHelp}
            loadError={loadError}
            allIssues={allIssues}
            shortcuts={shortcuts}
          />
        </ThemeProvider>
      </GraphI18nProvider>
    );
  }

  return (
    <GraphI18nProvider language={locale}>
    <ThemeProvider metaTheme={metaTheme}>
    <div className="h-screen w-screen flex flex-col bg-root text-text-primary noise-overlay">
      {/* Header */}
      <header className="flex items-center px-3 sm:px-5 py-3 bg-surface border-b border-border-subtle shrink-0 gap-2 sm:gap-4">
        {/* Left — fixed */}
        <div className="flex items-center gap-3 sm:gap-5 shrink-0 min-w-0">
          {onBackToWorkspace && (
            <button
              type="button"
              onClick={onBackToWorkspace}
              className="rounded-md border border-border-medium bg-elevated px-2.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary"
            >
              {t("app.projectsButton", "Projects")}
            </button>
          )}
          <h1 className="font-heading text-base sm:text-lg text-text-primary tracking-wide truncate max-w-[160px] sm:max-w-[220px] lg:max-w-none">
            {graph?.project.name ?? "Understand Anything"}
          </h1>
          <div className="w-px h-5 bg-border-subtle hidden sm:block" />
          <PersonaSelector />
          {graph && !isKnowledgeGraph && domainGraph && (
            <>
              <div className="w-px h-5 bg-border-subtle" />
              <div className="flex items-center bg-elevated rounded-lg p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode("domain")}
                  title={t("app.domainViewTitle", "Domain view")}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                    viewMode === "domain"
                      ? "bg-accent/20 text-accent"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {t("common.domain", "Domain")}
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("structural")}
                  title={t("app.structuralViewTitle", "Structural view")}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                    viewMode === "structural"
                      ? "bg-accent/20 text-accent"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {t("common.structural", "Structural")}
                </button>
              </div>
            </>
          )}
        </div>

        {/* Middle — scrollable legends */}
        <div className="flex-1 min-w-0 overflow-x-auto scrollbar-hide">
          <div className="flex items-center gap-4 w-max">
            <DiffToggle />
            {/* Detail level: file view (architecture) / class view (code structure) */}
            {!isKnowledgeGraph && viewMode !== "domain" && (
              <>
                <div className="w-px h-5 bg-border-subtle" />
                <div className="flex items-center bg-elevated rounded-lg p-0.5">
                  <button
                    type="button"
                    onClick={() => setDetailLevel("file")}
                    title={t("app.filesOnlyTitle", "Files only")}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                      detailLevel === "file"
                        ? "bg-accent/20 text-accent"
                        : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    {t("common.files", "Files")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDetailLevel("class")}
                    title={`${t("common.files", "Files")} + ${t("nodeTypes.class", "Class")}`}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                      detailLevel === "class"
                        ? "bg-accent/20 text-accent"
                        : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    +{t("nodeTypes.class", "Class")}
                  </button>
                </div>
                {detailLevel === "class" && (
                  <button
                    type="button"
                    onClick={toggleShowFunctionsInClassView}
                    title={t("nodeTypes.function", "Function")}
                    className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded border transition-colors ${
                      showFunctionsInClassView
                        ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                        : "border-border-medium bg-elevated text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    fn
                  </button>
                )}
              </>
            )}
            <div className="flex items-center gap-1">
              {(isKnowledgeGraph ? [
                { key: "knowledge" as const, label: t("common.all", "All"), color: "var(--color-node-article)" },
              ] : [
                { key: "code" as const, label: t("common.code", "Code"), color: "var(--color-node-file)" },
                { key: "config" as const, label: t("common.config", "Config"), color: "var(--color-node-config)" },
                { key: "docs" as const, label: t("common.docs", "Docs"), color: "var(--color-node-document)" },
                { key: "infra" as const, label: t("common.infra", "Infra"), color: "var(--color-node-service)" },
                { key: "data" as const, label: t("common.data", "Data"), color: "var(--color-node-table)" },
                { key: "domain" as const, label: t("common.domain", "Domain"), color: "var(--color-node-concept)" },
                { key: "knowledge" as const, label: t("common.knowledge", "Knowledge"), color: "var(--color-node-article)" },
              ]).map((cat) => (
                <button
                  key={cat.key}
                  onClick={() => toggleNodeTypeFilter(cat.key)}
                  className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded border transition-colors flex items-center gap-1.5 whitespace-nowrap ${
                    nodeTypeFilters[cat.key] !== false
                      ? "border-border-medium bg-elevated text-text-secondary hover:text-text-primary"
                      : "border-transparent bg-transparent text-text-muted/40 line-through hover:text-text-muted"
                  }`}
                  title={t(
                    nodeTypeFilters[cat.key] !== false ? "app.hideTitle" : "app.showTitle",
                    nodeTypeFilters[cat.key] !== false ? "Hide {name}" : "Show {name}",
                    { name: cat.label },
                  )}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      backgroundColor: cat.color,
                      opacity: nodeTypeFilters[cat.key] !== false ? 1 : 0.3,
                    }}
                  />
                  {cat.label}
                </button>
              ))}
            </div>
            <LayerLegend />
          </div>
        </div>

        {/* Right — fixed actions */}
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <FilterPanel />
          <ExportMenu />
          <button
            onClick={togglePathFinder}
            className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-sm bg-elevated text-text-secondary hover:text-text-primary transition-colors"
            title={t("shortcut.openPath", "Open dependency path finder")}
            aria-label={t("app.pathTitle", "Path")}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
              />
            </svg>
            <span className="hidden md:inline">{t("common.path", "Path")}</span>
          </button>
          <ThemePicker />
          <button
            onClick={() => setShowKeyboardHelp(true)}
            className="text-text-muted hover:text-accent transition-colors"
            title={t("app.keyboardTitle", "Keyboard shortcuts")}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </button>
        </div>
      </header>

      {/* Search */}
      <SearchBar />

      {/* Validation warning banner */}
      {allIssues.length > 0 && !loadError && (
        <WarningBanner issues={allIssues} />
      )}

      {/* Error banner */}
      {loadError && (
        <div className="px-5 py-3 bg-red-900/30 border-b border-red-700 text-red-200 text-sm">
          {loadError}
        </div>
      )}

      {/* Main content: left inspection sidebar + graph + assistant */}
      <div className="flex-1 flex min-h-0 relative">
        <aside
          className={`shrink-0 bg-surface border-r border-border-subtle overflow-hidden transition-[width] duration-200 ${
            leftSidebarCollapsed ? "w-12" : "w-[300px] lg:w-[340px] 2xl:w-[360px]"
          }`}
        >
          {leftSidebarCollapsed ? collapsedSidebarContent : sidebarContent}
        </aside>

        {/* Graph area */}
        <div className="flex-1 min-w-0 min-h-0 relative">
          {viewMode === "knowledge" ? (
            <KnowledgeGraphView />
          ) : viewMode === "domain" && domainGraph ? (
            <DomainGraphView />
          ) : (
            <GraphView />
          )}
          <div className="absolute top-3 right-3 text-sm text-text-muted/60 pointer-events-none select-none">
            {t("app.pressShortcut", "Press ? for keyboard shortcuts")}
          </div>

          {/* Code viewer slide-up overlay (collapsed state), scoped to graph pane. */}
          {codeViewerOpen && !codeViewerExpanded && (
            <div className="absolute bottom-0 left-0 right-0 h-[40vh] bg-surface border-t border-border-subtle animate-slide-up z-20 overflow-hidden">
              <Suspense fallback={null}>
                <CodeViewer
                  accessToken={accessToken}
                  projectId={currentProjectId}
                  projectParams={projectParams}
                  onExpand={expandCodeViewer}
                />
              </Suspense>
            </div>
          )}
        </div>

        {showAssistant && (
          <div className="w-[380px] xl:w-[420px] 2xl:w-[460px] shrink-0 min-w-0">
            <AssistantWorkbench projectId={currentProjectId} projectParams={projectParams} />
          </div>
        )}
      </div>

      {/* Expanded code viewer modal */}
      {codeViewerOpen && codeViewerExpanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4 sm:p-6"
          onMouseDown={collapseCodeViewer}
        >
          <div
            className="w-[calc(100vw-32px)] max-w-[1120px] h-[calc(100vh-32px)] sm:h-[calc(100vh-48px)] max-h-[820px] rounded-lg border border-border-medium bg-surface shadow-2xl overflow-hidden"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <Suspense fallback={null}>
              <CodeViewer
                accessToken={accessToken}
                projectId={currentProjectId}
                projectParams={projectParams}
                presentation="modal"
                onClose={collapseCodeViewer}
              />
            </Suspense>
          </div>
        </div>
      )}

      {/* Keyboard shortcuts help modal */}
      {showKeyboardHelp && (
        <Suspense fallback={null}>
          <KeyboardShortcutsHelp
            shortcuts={shortcuts}
            onClose={() => setShowKeyboardHelp(false)}
          />
        </Suspense>
      )}

      {/* Path Finder Modal — only mounted when open so its chunk is lazy-loaded on demand. */}
      {pathFinderOpen && (
        <Suspense fallback={null}>
          <PathFinderModal isOpen={pathFinderOpen} onClose={togglePathFinder} />
        </Suspense>
      )}
    </div>
    </ThemeProvider>
    </GraphI18nProvider>
  );
}

export default App;
