import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildCanvasGraphModel } from "../canvas/graphModel";
import { createLeaferGraph } from "../canvas/createLeaferGraph";
import type { LeaferGraphController } from "../canvas/createLeaferGraph";
import { placeGraphContextMenu } from "../canvas/graphContextMenu";
import type { GraphContextMenuState } from "../canvas/graphContextMenu";
import { useDashboardStore } from "../store";

export default function CanvasGraphOverview() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<LeaferGraphController | null>(null);
  const callbackRef = useRef({
    selectNode: (_nodeId: string | null) => {},
    navigateToNodeInLayer: (_nodeId: string) => {},
    addGraphNodeToAssistantContext: (_nodeId: string) => {},
    setContextMenu: (_menu: GraphContextMenuState | null) => {},
  });
  const graph = useDashboardStore((s) => s.graph);
  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);
  const searchResults = useDashboardStore((s) => s.searchResults);
  const tourHighlightedNodeIds = useDashboardStore((s) => s.tourHighlightedNodeIds);
  const selectNode = useDashboardStore((s) => s.selectNode);
  const navigateToNodeInLayer = useDashboardStore((s) => s.navigateToNodeInLayer);
  const addGraphNodeToAssistantContext = useDashboardStore((s) => s.addGraphNodeToAssistantContext);
  const [contextMenu, setContextMenu] = useState<GraphContextMenuState | null>(null);

  const model = useMemo(() => (graph ? buildCanvasGraphModel(graph) : null), [graph]);
  const highlightedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const result of searchResults) ids.add(result.nodeId);
    for (const nodeId of tourHighlightedNodeIds) ids.add(nodeId);
    return ids;
  }, [searchResults, tourHighlightedNodeIds]);

  useEffect(() => {
    callbackRef.current = {
      selectNode,
      navigateToNodeInLayer,
      addGraphNodeToAssistantContext,
      setContextMenu,
    };
  }, [addGraphNodeToAssistantContext, navigateToNodeInLayer, selectNode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !model) return;

    const controller = createLeaferGraph({
      host,
      model,
      selectedNodeId,
      highlightedNodeIds,
      callbacks: {
        onSelectNode: (nodeId) => {
          callbackRef.current.setContextMenu(null);
          callbackRef.current.selectNode(nodeId);
        },
        onOpenNode: (nodeId) => {
          callbackRef.current.setContextMenu(null);
          callbackRef.current.navigateToNodeInLayer(nodeId);
        },
        onOpenContextMenu: (node, clientX, clientY) => {
          const rect = containerRef.current?.getBoundingClientRect() ?? host.getBoundingClientRect();
          callbackRef.current.setContextMenu(placeGraphContextMenu(node, clientX, clientY, rect));
        },
        onClearSelection: () => {
          callbackRef.current.setContextMenu(null);
          callbackRef.current.selectNode(null);
        },
      },
    });
    controllerRef.current = controller;

    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, [model]);

  useEffect(() => {
    controllerRef.current?.updateState({
      selectedNodeId,
      highlightedNodeIds,
    });
  }, [highlightedNodeIds, selectedNodeId]);

  const handleAddContext = useCallback(() => {
    if (!contextMenu) return;
    addGraphNodeToAssistantContext(contextMenu.node.id);
    setContextMenu(null);
  }, [addGraphNodeToAssistantContext, contextMenu]);

  const handleOpenDetail = useCallback(() => {
    if (!contextMenu) return;
    navigateToNodeInLayer(contextMenu.node.id);
    setContextMenu(null);
  }, [contextMenu, navigateToNodeInLayer]);

  if (!graph || !model) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-root rounded-lg">
        <p className="text-text-muted text-sm">尚未加载知识图谱</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden rounded-lg bg-root pt-10">
      <div
        ref={hostRef}
        className="h-full w-full outline-none"
        style={{ touchAction: "none", cursor: "grab" }}
      />
      <div className="pointer-events-none absolute bottom-4 left-4 rounded-md border border-border-subtle bg-surface/90 px-3 py-2 text-xs text-text-muted shadow-lg">
        {model.nodes.length} nodes / {model.edges.length} edges
      </div>
      {contextMenu && (
        <div
          className="absolute z-20 min-w-52 rounded-md border border-border-subtle bg-elevated p-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="px-3 py-2 text-xs text-text-muted truncate">
            {contextMenu.node.label}
          </div>
          <button
            type="button"
            onClick={handleAddContext}
            className="block w-full rounded px-3 py-2 text-left text-sm text-text-primary hover:bg-gold/10"
          >
            加入 AstrBot 会话
          </button>
          <button
            type="button"
            onClick={handleOpenDetail}
            className="block w-full rounded px-3 py-2 text-left text-sm text-text-primary hover:bg-gold/10"
          >
            进入局部详情
          </button>
        </div>
      )}
    </div>
  );
}
