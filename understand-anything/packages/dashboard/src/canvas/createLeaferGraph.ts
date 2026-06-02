import { Ellipse, Group, Leafer, Path, Text } from "leafer-ui";
import { getGraphLevelOfDetail } from "./graphLevelOfDetail";
import { buildGraphHitIndex, findNearestGraphNode } from "./graphHitTest";
import {
  fitCanvasBounds,
  screenToWorldPoint,
  zoomCanvasViewportAt,
} from "./graphViewport";
import type { CanvasGraphModel, CanvasGraphNode, CanvasPoint } from "./graphTypes";
import type { CanvasViewport } from "./graphViewport";

type LeaferEllipse = InstanceType<typeof Ellipse>;
type LeaferPath = InstanceType<typeof Path>;
type LeaferText = InstanceType<typeof Text>;

export interface LeaferGraphCallbacks {
  onSelectNode: (nodeId: string) => void;
  onOpenNode: (nodeId: string) => void;
  onOpenContextMenu: (node: CanvasGraphNode, clientX: number, clientY: number) => void;
  onClearSelection: () => void;
}

export interface CreateLeaferGraphOptions {
  host: HTMLElement;
  model: CanvasGraphModel;
  selectedNodeId: string | null;
  highlightedNodeIds: Set<string>;
  callbacks: LeaferGraphCallbacks;
}

export interface LeaferGraphController {
  updateState: (state: {
    selectedNodeId: string | null;
    highlightedNodeIds: Set<string>;
  }) => void;
  destroy: () => void;
}

const MIN_ZOOM = 0.03;
const MAX_ZOOM = 4;
const HIT_RADIUS_SCREEN_PX = 10;
const FIT_PADDING = 72;

function pointerPoint(event: MouseEvent | PointerEvent | WheelEvent): CanvasPoint {
  return { x: event.clientX, y: event.clientY };
}

function hostPoint(host: HTMLElement, event: MouseEvent | PointerEvent | WheelEvent): CanvasPoint {
  const rect = host.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function lodKeyForZoom(zoom: number): string {
  if (!Number.isFinite(zoom) || zoom < 0.3) return "low";
  if (zoom < 1.1) return "mid";
  if (zoom < 1.35) return "high";
  return "detail";
}

function fitInitialViewport(host: HTMLElement, model: CanvasGraphModel): CanvasViewport {
  const rect = host.getBoundingClientRect();
  return fitCanvasBounds(model.bounds, rect.width, rect.height, FIT_PADDING);
}

function edgePathData(
  edges: CanvasGraphModel["edges"],
  nodeById: Map<string, CanvasGraphNode>,
): string {
  const parts: string[] = [];
  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    parts.push(`M ${source.x} ${source.y} L ${target.x} ${target.y}`);
  }
  return parts.join(" ");
}

function circlePathData(nodes: CanvasGraphNode[], radiusOffset = 0): string {
  const parts: string[] = [];
  for (const node of nodes) {
    const radius = node.radius + radiusOffset;
    const right = node.x + radius;
    const left = node.x - radius;
    parts.push(
      `M ${right} ${node.y}`,
      `A ${radius} ${radius} 0 1 0 ${left} ${node.y}`,
      `A ${radius} ${radius} 0 1 0 ${right} ${node.y}`,
      "Z",
    );
  }
  return parts.join(" ");
}

function nodeStrokeForColor(color: string): string {
  if (color === "#f59e0b") return "rgba(254, 243, 199, 0.42)";
  if (color === "#10b981" || color === "#22c55e") return "rgba(209, 250, 229, 0.38)";
  if (color === "#ef4444" || color === "#f43f5e") return "rgba(254, 202, 202, 0.38)";
  return "rgba(255, 255, 255, 0.32)";
}

function createNodeOverlay(node: CanvasGraphNode, fill: string, stroke: string): LeaferEllipse {
  const radius = node.radius + 2;
  return new Ellipse({
    x: node.x - radius,
    y: node.y - radius,
    width: radius * 2,
    height: radius * 2,
    fill,
    stroke,
    strokeWidth: 2,
    strokeScaleFixed: true,
    hittable: false,
  });
}

export function createLeaferGraph({
  host,
  model,
  selectedNodeId,
  highlightedNodeIds,
  callbacks,
}: CreateLeaferGraphOptions): LeaferGraphController {
  const leafer = new Leafer({
    view: host,
    fill: "rgba(15, 23, 42, 0.96)",
    start: true,
    hittable: false,
  });
  const scene = new Group({ hittable: false });
  const edgeLayer = new Group({ hittable: false });
  const nodeLayer = new Group({ hittable: false });
  const overlayLayer = new Group({ hittable: false });
  const labelLayer = new Group({ hittable: false });
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const highlightShapes = new Map<string, LeaferEllipse>();
  const labelShapes = new Map<string, LeaferText>();
  const hitIndex = buildGraphHitIndex(model.nodes, 128);
  let selectedShape: LeaferEllipse | null = null;
  let viewport = fitInitialViewport(host, model);
  let renderedViewport = viewport;
  let frameId: number | null = null;
  let commitTimerId: number | null = null;
  let latestSelectedNodeId = selectedNodeId;
  let latestHighlightedNodeIds = highlightedNodeIds;
  let lastRenderKey = "";
  let hasUserMovedViewport = false;
  let dragStart: CanvasPoint | null = null;
  let dragViewport: CanvasViewport | null = null;
  let didDrag = false;

  leafer.add(scene);
  scene.add(edgeLayer);
  scene.add(nodeLayer);
  scene.add(overlayLayer);
  scene.add(labelLayer);

  const edgePath = new Path({
    path: edgePathData(model.edges, nodeById),
    stroke: "rgba(148, 163, 184, 1)",
    strokeWidth: 1,
    strokeScaleFixed: true,
    opacity: 0,
    visible: false,
    hittable: false,
  });
  edgeLayer.add(edgePath);

  const nodesByColor = new Map<string, CanvasGraphNode[]>();
  for (const node of model.nodes) {
    const nodes = nodesByColor.get(node.color);
    if (nodes) {
      nodes.push(node);
    } else {
      nodesByColor.set(node.color, [node]);
    }
  }

  const baseNodePaths: LeaferPath[] = [];
  for (const [color, nodes] of nodesByColor) {
    const path = new Path({
      path: circlePathData(nodes),
      fill: color,
      stroke: nodeStrokeForColor(color),
      strokeWidth: 1,
      strokeScaleFixed: true,
      hittable: false,
    });
    nodeLayer.add(path);
    baseNodePaths.push(path);
  }

  function leaferCanvasView(): HTMLElement | null {
    return host.querySelector("canvas");
  }

  function nodeAtEvent(event: MouseEvent | PointerEvent | WheelEvent): CanvasGraphNode | null {
    const point = hostPoint(host, event);
    const worldPoint = screenToWorldPoint(viewport, point);
    return findNearestGraphNode(hitIndex, worldPoint, HIT_RADIUS_SCREEN_PX / viewport.zoom);
  }

  function syncLabels(labelLimit: number, showLabels: boolean): void {
    const visibleLabelIds = new Set<string>();
    if (showLabels) {
      for (const node of model.nodes.slice(0, labelLimit)) {
        visibleLabelIds.add(node.id);
      }
    }
    if (latestSelectedNodeId) visibleLabelIds.add(latestSelectedNodeId);
    for (const nodeId of latestHighlightedNodeIds) visibleLabelIds.add(nodeId);

    for (const [nodeId, label] of labelShapes) {
      label.visible = visibleLabelIds.has(nodeId);
    }

    for (const nodeId of visibleLabelIds) {
      if (labelShapes.has(nodeId)) continue;
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const label = new Text({
        x: node.x + node.radius + 5,
        y: node.y - 8,
        text: node.label,
        fontSize: 12,
        fill: "rgba(226, 232, 240, 0.92)",
        stroke: "rgba(15, 23, 42, 0.85)",
        strokeWidth: 3,
        strokeScaleFixed: true,
        hittable: false,
      });
      labelLayer.add(label);
      labelShapes.set(nodeId, label);
    }
  }

  function syncOverlays(): void {
    if (selectedShape) {
      selectedShape.remove();
      selectedShape = null;
    }
    if (latestSelectedNodeId) {
      const selectedNode = nodeById.get(latestSelectedNodeId);
      if (selectedNode) {
        selectedShape = createNodeOverlay(selectedNode, "#facc15", "#fef9c3");
        overlayLayer.add(selectedShape);
      }
    }

    for (const [nodeId, shape] of highlightShapes) {
      if (!latestHighlightedNodeIds.has(nodeId)) {
        shape.remove();
        highlightShapes.delete(nodeId);
      }
    }
    for (const nodeId of latestHighlightedNodeIds) {
      if (nodeId === latestSelectedNodeId || highlightShapes.has(nodeId)) continue;
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const shape = createNodeOverlay(node, "#38bdf8", "#bae6fd");
      overlayLayer.add(shape);
      highlightShapes.set(nodeId, shape);
    }
  }

  function applyVisualState(force = false): void {
    const lod = getGraphLevelOfDetail(viewport.zoom);
    const renderKey = [
      lodKeyForZoom(viewport.zoom),
      lod.showEdges,
      lod.showLabels,
      lod.showEdgeLabels,
      lod.nodeRadius,
      latestSelectedNodeId ?? "",
      [...latestHighlightedNodeIds].sort().join("|"),
    ].join(":");
    if (!force && renderKey === lastRenderKey) return;
    lastRenderKey = renderKey;

    edgeLayer.visible = lod.showEdges;
    edgePath.visible = lod.showEdges;
    edgePath.opacity = lod.edgeAlpha;

    const dimBaseNodes = Boolean(latestSelectedNodeId);
    for (const path of baseNodePaths) {
      path.opacity = dimBaseNodes ? 0.45 : 1;
    }

    syncOverlays();
    syncLabels(lod.labelLimit, lod.showLabels);
  }

  function renderViewport(force = false): void {
    scene.set({
      x: viewport.x,
      y: viewport.y,
      scaleX: viewport.zoom,
      scaleY: viewport.zoom,
    });
    applyVisualState(force);
  }

  function applyViewportPreviewTransform(): void {
    const view = leaferCanvasView();
    if (!view) return;
    const scale = viewport.zoom / renderedViewport.zoom;
    const x = viewport.x - renderedViewport.x * scale;
    const y = viewport.y - renderedViewport.y * scale;
    view.style.transformOrigin = "0 0";
    view.style.willChange = "transform";
    view.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  function resetViewportPreviewTransform(): void {
    const view = leaferCanvasView();
    if (!view) return;
    view.style.transform = "";
    view.style.willChange = "";
  }

  function commitViewportRender(force = false): void {
    renderViewport(force);
    renderedViewport = viewport;
    window.requestAnimationFrame(resetViewportPreviewTransform);
  }

  function scheduleViewportCommit(): void {
    if (commitTimerId !== null) {
      window.clearTimeout(commitTimerId);
    }
    commitTimerId = window.setTimeout(() => {
      commitTimerId = null;
      commitViewportRender();
    }, 900);
  }

  function requestViewportRender(): void {
    if (frameId !== null) return;
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      applyViewportPreviewTransform();
    });
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    hasUserMovedViewport = true;
    const factor = Math.exp(-event.deltaY * 0.001);
    viewport = zoomCanvasViewportAt(
      viewport,
      hostPoint(host, event),
      factor,
      MIN_ZOOM,
      MAX_ZOOM,
    );
    requestViewportRender();
    scheduleViewportCommit();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    dragStart = pointerPoint(event);
    dragViewport = viewport;
    didDrag = false;
    host.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (dragStart && dragViewport) {
      const point = pointerPoint(event);
      const dx = point.x - dragStart.x;
      const dy = point.y - dragStart.y;
      didDrag = didDrag || Math.abs(dx) > 3 || Math.abs(dy) > 3;
      viewport = {
        x: dragViewport.x + dx,
        y: dragViewport.y + dy,
        zoom: dragViewport.zoom,
      };
      hasUserMovedViewport = true;
      requestViewportRender();
      scheduleViewportCommit();
      return;
    }

    host.style.cursor = nodeAtEvent(event) ? "pointer" : "grab";
  }

  function onPointerUp(event: PointerEvent): void {
    if (dragStart) {
      host.releasePointerCapture(event.pointerId);
    }
    dragStart = null;
    dragViewport = null;
    host.style.cursor = "grab";
  }

  function onClick(event: MouseEvent): void {
    if (didDrag) {
      didDrag = false;
      return;
    }
    const node = nodeAtEvent(event);
    if (node) {
      callbacks.onSelectNode(node.id);
      return;
    }
    callbacks.onClearSelection();
  }

  function onDoubleClick(event: MouseEvent): void {
    const node = nodeAtEvent(event);
    if (node) callbacks.onOpenNode(node.id);
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const node = nodeAtEvent(event);
    if (!node) {
      callbacks.onClearSelection();
      return;
    }
    callbacks.onOpenContextMenu(node, event.clientX, event.clientY);
  }

  const resizeObserver = new ResizeObserver(() => {
    if (hasUserMovedViewport) return;
    viewport = fitInitialViewport(host, model);
    commitViewportRender(true);
  });

  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
  host.addEventListener("pointercancel", onPointerUp);
  host.addEventListener("click", onClick);
  host.addEventListener("dblclick", onDoubleClick);
  host.addEventListener("contextmenu", onContextMenu);
  resizeObserver.observe(host);
  commitViewportRender(true);

  return {
    updateState(state) {
      latestSelectedNodeId = state.selectedNodeId;
      latestHighlightedNodeIds = state.highlightedNodeIds;
      commitViewportRender(true);
    },
    destroy() {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      if (commitTimerId !== null) {
        window.clearTimeout(commitTimerId);
        commitTimerId = null;
      }
      resizeObserver.disconnect();
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      host.removeEventListener("click", onClick);
      host.removeEventListener("dblclick", onDoubleClick);
      host.removeEventListener("contextmenu", onContextMenu);
      leafer.destroy();
    },
  };
}
