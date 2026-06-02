import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  createGraphRendererController,
  type GraphRendererController,
} from "../canvas/graphRendererController";
import type { CanvasViewport } from "../canvas/graphViewport";
import {
  buildGraphSceneMiniMap,
  miniMapPointToScenePoint,
  projectViewportToMiniMap,
} from "../canvas/graphSceneMinimap";
import type { GraphSceneModel, GraphSceneNode } from "../graph-scene/graphSceneTypes";
import { useDashboardStore } from "../store";

interface CanvasGraphRendererProps {
  scene: GraphSceneModel | null;
  layoutStatus?: "computing" | "ready";
  stats?: {
    nodes: number;
    edges: number;
  };
  onNodeClick: (node: GraphSceneNode) => void;
  onPaneClick: () => void;
  onNodeContextMenu?: (node: GraphSceneNode, clientX: number, clientY: number) => void;
  onPaneContextMenu?: () => void;
  onViewportChange?: (viewport: CanvasViewport, source: "user" | "programmatic") => void;
}

export default function CanvasGraphRenderer({
  scene,
  layoutStatus = "ready",
  stats,
  onNodeClick,
  onPaneClick,
  onNodeContextMenu,
  onPaneContextMenu,
  onViewportChange,
}: CanvasGraphRendererProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<GraphRendererController | null>(null);
  const lastSceneRef = useRef<GraphSceneModel | null>(null);
  const callbacksRef = useRef({
    onNodeClick,
    onPaneClick,
    onNodeContextMenu,
    onPaneContextMenu,
    onViewportChange,
  });
  const [viewport, setViewport] = useState<CanvasViewport | null>(null);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const setGraphRendererController = useDashboardStore((s) => s.setGraphRendererController);
  const hasScene = scene !== null;
  const miniMap = useMemo(
    () => (scene ? buildGraphSceneMiniMap(scene, 160, 110, 8) : null),
    [scene],
  );
  const miniMapViewport = useMemo(() => {
    if (!miniMap || !viewport || hostSize.width <= 0 || hostSize.height <= 0) return null;
    return projectViewportToMiniMap(
      miniMap,
      viewport,
      hostSize.width,
      hostSize.height,
    );
  }, [hostSize, miniMap, viewport]);

  useEffect(() => {
    callbacksRef.current = {
      onNodeClick,
      onPaneClick,
      onNodeContextMenu,
      onPaneContextMenu,
      onViewportChange,
    };
  }, [onNodeClick, onNodeContextMenu, onPaneClick, onPaneContextMenu, onViewportChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const updateSize = () => {
      setHostSize({
        width: host.clientWidth,
        height: host.clientHeight,
      });
    };
    updateSize();

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(host);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !scene) return;

    const initialScene = scene;
    const controller = createGraphRendererController({
      host,
      sceneModel: initialScene,
      callbacks: {
        onNodeClick: (node) => callbacksRef.current.onNodeClick(node),
        onPaneClick: () => callbacksRef.current.onPaneClick(),
        onNodeContextMenu: (node, clientX, clientY) => {
          callbacksRef.current.onNodeContextMenu?.(node, clientX, clientY);
        },
        onPaneContextMenu: () => callbacksRef.current.onPaneContextMenu?.(),
        onViewportChange: (nextViewport, source) => {
          setViewport(nextViewport);
          callbacksRef.current.onViewportChange?.(nextViewport, source);
        },
      },
    });
    controllerRef.current = controller;
    lastSceneRef.current = initialScene;
    setViewport(controller.getViewport());
    setGraphRendererController(controller);

    return () => {
      controller.destroy();
      controllerRef.current = null;
      lastSceneRef.current = null;
      setViewport(null);
      setGraphRendererController(null);
    };
  }, [hasScene, setGraphRendererController]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!scene || !controller || lastSceneRef.current === scene) return;

    controller.updateScene(scene);
    lastSceneRef.current = scene;
    setViewport(controller.getViewport());
  }, [scene]);

  const handleMiniMapPointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!miniMap) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - rect.left) * (miniMap.width / rect.width);
      const y = (event.clientY - rect.top) * (miniMap.height / rect.height);
      const center = miniMapPointToScenePoint(miniMap, { x, y });
      controllerRef.current?.setCenter(center.x, center.y);
    },
    [miniMap],
  );

  return (
    <div className="absolute inset-0 overflow-hidden rounded-lg bg-root">
      <div
        ref={hostRef}
        className="h-full w-full outline-none"
        style={{
          touchAction: "none",
          cursor: scene ? "grab" : "default",
          backgroundImage: "radial-gradient(var(--color-edge-dot) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      />
      {stats && (
        <div className="pointer-events-none absolute bottom-4 left-4 rounded-md border border-border-subtle bg-surface/90 px-3 py-2 text-xs text-text-muted shadow-lg">
          {stats.nodes} nodes / {stats.edges} edges
        </div>
      )}
      {scene && (
        <div className="absolute bottom-4 right-4 z-10 flex items-end gap-2">
          <div className="overflow-hidden rounded-md border border-border-subtle bg-surface/90 shadow-lg">
            <button
              type="button"
              className="block h-8 w-8 border-b border-border-subtle text-sm text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary"
              onClick={() => controllerRef.current?.zoomBy(1.2)}
              aria-label="放大"
            >
              +
            </button>
            <button
              type="button"
              className="block h-8 w-8 border-b border-border-subtle text-sm text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary"
              onClick={() => controllerRef.current?.zoomBy(1 / 1.2)}
              aria-label="缩小"
            >
              -
            </button>
            <button
              type="button"
              className="block h-8 w-8 text-[10px] text-text-secondary transition-colors hover:bg-elevated hover:text-text-primary"
              onClick={() => controllerRef.current?.fitView()}
              aria-label="适应视图"
            >
              fit
            </button>
          </div>
          {miniMap && (
            <svg
              width={miniMap.width}
              height={miniMap.height}
              viewBox={miniMap.viewBox}
              className="cursor-crosshair rounded-md border border-border-subtle bg-surface/90 shadow-lg"
              aria-label="缩略图"
              role="button"
              tabIndex={0}
              onPointerDown={handleMiniMapPointerDown}
            >
              <rect width="100%" height="100%" fill="var(--color-surface)" opacity="0.85" />
              {miniMap.items.map((item) => (
                <rect
                  key={item.id}
                  x={item.x}
                  y={item.y}
                  width={item.width}
                  height={item.height}
                  rx="2"
                  fill={item.selected || item.highlighted ? "var(--color-accent)" : "var(--color-elevated)"}
                  stroke={item.selected ? "var(--color-accent-bright)" : "var(--color-border-subtle)"}
                  strokeWidth="1"
                  opacity={item.kind === "container" ? 0.45 : 0.9}
                />
              ))}
              {miniMapViewport && (
                <rect
                  x={miniMapViewport.x}
                  y={miniMapViewport.y}
                  width={miniMapViewport.width}
                  height={miniMapViewport.height}
                  rx="3"
                  fill="rgba(212,165,116,0.08)"
                  stroke="var(--color-gold)"
                  strokeWidth="1.5"
                />
              )}
            </svg>
          )}
        </div>
      )}
      {(!scene || layoutStatus === "computing") && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-root/40">
          <span className="text-sm text-gold">
            {scene ? "正在计算布局..." : "正在准备图谱..."}
          </span>
        </div>
      )}
    </div>
  );
}
