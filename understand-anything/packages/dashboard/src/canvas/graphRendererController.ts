import { Ellipse, Group, Leafer, Path, Rect, Text } from "leafer-ui";
import {
  buildGraphSceneHitIndex,
  findGraphSceneNodeAt,
} from "./graphHitTest";
import {
  centerCanvasViewportOn,
  fitCanvasSceneNodes,
  screenToWorldPoint,
  zoomCanvasViewportAt,
} from "./graphViewport";
import {
  applyGraphSceneRenderableVisibility,
  getVisibleGraphSceneItems,
  type GraphSceneRenderableRef,
} from "./graphSceneCulling";
import {
  buildEdgeLabelTextPaintOptions,
  GRAPH_RENDER_LAYER_ORDER,
  type GraphRenderLayerName,
} from "./graphRendererSceneLayers";
import { buildEdgePaintSpecs, type EdgePaintSpec } from "./renderEdges";
import { buildContainerNodePaintSpec } from "./renderContainerNode";
import { buildCustomNodePaintSpec } from "./renderCustomNode";
import {
  buildLayerClusterPaintSpec,
  type RectPaintSpec,
  type TextPaintSpec,
} from "./renderLayerCluster";
import { buildPortalNodePaintSpec } from "./renderPortalNode";
import type { CanvasPoint } from "./graphTypes";
import type { CanvasViewport } from "./graphViewport";
import type { GraphSceneEdge, GraphSceneModel, GraphSceneNode } from "../graph-scene/graphSceneTypes";

export interface GraphRendererCallbacks {
  onNodeClick: (node: GraphSceneNode) => void;
  onPaneClick: () => void;
  onNodeContextMenu?: (node: GraphSceneNode, clientX: number, clientY: number) => void;
  onPaneContextMenu?: () => void;
  onViewportChange?: (viewport: CanvasViewport, source: "user" | "programmatic") => void;
}

export interface CreateGraphRendererControllerOptions {
  host: HTMLElement;
  sceneModel: GraphSceneModel;
  callbacks: GraphRendererCallbacks;
}

export interface GraphRendererController {
  fitView: () => void;
  fitNodes: (nodeIds: readonly string[]) => void;
  setCenter: (x: number, y: number, options?: { zoom?: number }) => void;
  zoomBy: (factor: number) => void;
  updateScene: (sceneModel: GraphSceneModel) => void;
  getViewport: () => CanvasViewport;
  getSceneSnapshot: () => GraphSceneModel;
  destroy: () => void;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 2.5;
const FIT_PADDING = 72;
const CULLING_PADDING = 240;
const SIGNATURE_FIELD_SEPARATOR = "\u0000";
const SIGNATURE_ITEM_SEPARATOR = "\u0001";
const SIGNATURE_SECTION_SEPARATOR = "\u0002";

type RenderableGroup = Group & { visible: boolean };

interface SceneRenderables {
  layers: Record<GraphRenderLayerName, Group>;
  nodeRenderables: GraphSceneRenderableRef<RenderableGroup>[];
  edgeRenderables: GraphSceneRenderableRef<RenderableGroup>[];
  nodeGroups: Map<string, RenderableGroup>;
  edgeGroups: Map<string, EdgeRenderableGroups>;
}

interface EdgeRenderableGroups {
  pathGroup: RenderableGroup;
  labelGroup?: RenderableGroup;
}

function hostPoint(host: HTMLElement, event: MouseEvent | PointerEvent | WheelEvent): CanvasPoint {
  const rect = host.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function pointerPoint(event: MouseEvent | PointerEvent): CanvasPoint {
  return { x: event.clientX, y: event.clientY };
}

function resolveCssValue(value: string, styles: CSSStyleDeclaration): string {
  const match = value.match(/^var\((--[^,)]+)(?:,\s*([^)]+))?\)$/);
  if (!match) return value;
  const tokenValue = styles.getPropertyValue(match[1]).trim();
  return tokenValue || match[2]?.trim() || value;
}

function nodeAtPoint(
  host: HTMLElement,
  viewport: CanvasViewport,
  hitIndex: ReturnType<typeof buildGraphSceneHitIndex>,
  event: MouseEvent | PointerEvent | WheelEvent,
): GraphSceneNode | null {
  const point = hostPoint(host, event);
  const worldPoint = screenToWorldPoint(viewport, point);
  return findGraphSceneNodeAt(hitIndex, worldPoint);
}

function drawLayerCluster(
  layer: Group,
  node: GraphSceneNode,
  styles: CSSStyleDeclaration,
): void {
  const spec = buildLayerClusterPaintSpec(node);
  layer.add(rectFromSpec(spec.card, styles, "0 4px 16px rgba(0,0,0,0.4)"));
  layer.add(rectFromSpec(spec.strip, styles));
  addTexts(layer, spec.texts, styles);
  addHandleDots(layer, node, styles);
}

function rectFromSpec(
  spec: RectPaintSpec,
  styles: CSSStyleDeclaration,
  shadow?: string,
): Rect {
  return new Rect({
    x: spec.x,
    y: spec.y,
    width: spec.width,
    height: spec.height,
    cornerRadius: spec.cornerRadius,
    fill: resolveCssValue(spec.fill, styles),
    stroke: spec.stroke ? resolveCssValue(spec.stroke, styles) : undefined,
    strokeWidth: spec.strokeWidth,
    shadow,
    hittable: false,
  });
}

function addTexts(layer: Group, texts: readonly TextPaintSpec[], styles: CSSStyleDeclaration): void {
  for (const text of texts) {
    layer.add(
      new Text({
        x: text.x,
        y: text.y,
        width: text.width,
        text: text.text,
        fill: resolveCssValue(text.fill, styles),
        fontSize: text.fontSize,
        fontWeight: text.fontWeight,
        lineHeight: text.fontSize + 4,
        textOverflow: "ellipsis",
        hittable: false,
      }),
    );
  }
}

function addHandleDots(layer: Group, node: GraphSceneNode, styles: CSSStyleDeclaration): void {
  const handleFill = resolveCssValue("var(--color-text-muted)", styles);
  layer.add(
    new Ellipse({
      x: node.x + node.width / 2 - 4,
      y: node.y - 4,
      width: 8,
      height: 8,
      fill: handleFill,
      hittable: false,
    }),
  );
  layer.add(
    new Ellipse({
      x: node.x + node.width / 2 - 4,
      y: node.y + node.height - 4,
      width: 8,
      height: 8,
      fill: handleFill,
      hittable: false,
    }),
  );
}

function drawCustomNode(
  layer: Group,
  node: GraphSceneNode,
  styles: CSSStyleDeclaration,
): void {
  const spec = buildCustomNodePaintSpec(node);
  layer.add(rectFromSpec(spec.card, styles, "0 2px 8px rgba(0,0,0,0.3)"));
  layer.add(rectFromSpec(spec.strip, styles));
  if (spec.testedMarker) {
    layer.add(rectFromSpec(spec.testedMarker, styles));
  }
  addTexts(layer, spec.texts, styles);
  addHandleDots(layer, node, styles);
}

function drawContainerNode(
  layer: Group,
  node: GraphSceneNode,
  styles: CSSStyleDeclaration,
): void {
  const spec = buildContainerNodePaintSpec(node);
  layer.add(rectFromSpec(spec.card, styles));
  addTexts(layer, spec.texts, styles);
}

function drawPortalNode(
  layer: Group,
  node: GraphSceneNode,
  styles: CSSStyleDeclaration,
): void {
  const spec = buildPortalNodePaintSpec(node);
  layer.add(rectFromSpec(spec.card, styles, "0 2px 8px rgba(0,0,0,0.2)"));
  layer.add(rectFromSpec(spec.dot, styles));
  addTexts(layer, spec.texts, styles);
  addHandleDots(layer, node, styles);
}

function drawNodeContents(
  layer: Group,
  node: GraphSceneNode,
  styles: CSSStyleDeclaration,
): void {
  if (node.kind === "layer-cluster") {
    drawLayerCluster(layer, node, styles);
  } else if (node.kind === "custom") {
    drawCustomNode(layer, node, styles);
  } else if (node.kind === "container") {
    drawContainerNode(layer, node, styles);
  } else if (node.kind === "portal") {
    drawPortalNode(layer, node, styles);
  }
}

function drawEdgePath(
  layer: Group,
  edge: EdgePaintSpec,
): void {
  layer.add(
    new Path({
      path: edge.path,
      stroke: edge.stroke,
      strokeWidth: edge.strokeWidth,
      dashPattern: edge.dashPattern,
      strokeScaleFixed: true,
      hittable: false,
    }),
  );
}

function drawEdgeLabel(
  layer: Group,
  edge: NonNullable<EdgePaintSpec["label"]>,
): void {
  layer.add(
    new Text(buildEdgeLabelTextPaintOptions(edge)),
  );
}

function drawScene(
  root: Group,
  sceneModel: GraphSceneModel,
  styles: CSSStyleDeclaration,
): SceneRenderables {
  const layers: Record<GraphRenderLayerName, Group> = {
    background: new Group({ hittable: false }),
    edge: new Group({ hittable: false }),
    label: new Group({ hittable: false }),
    node: new Group({ hittable: false }),
  };
  const edgeLayer = layers.edge;
  const labelLayer = layers.label;
  const nodeLayer = layers.node;
  const nodesById = new Map(sceneModel.nodes.map((node) => [node.id, node]));
  const nodeRenderables: GraphSceneRenderableRef<RenderableGroup>[] = [];
  const edgeRenderables: GraphSceneRenderableRef<RenderableGroup>[] = [];
  const nodeGroups = new Map<string, RenderableGroup>();
  const edgeGroups = new Map<string, EdgeRenderableGroups>();

  for (const layerName of GRAPH_RENDER_LAYER_ORDER) {
    root.add(layers[layerName]);
  }

  for (const edge of buildEdgePaintSpecs(sceneModel.edges, nodesById)) {
    const edgeGroup = new Group({ hittable: false }) as RenderableGroup;
    edgeGroup.visible = true;
    drawEdgePath(edgeGroup, edge);
    edgeLayer.add(edgeGroup);
    edgeRenderables.push({ id: edge.id, group: edgeGroup });
    const edgeEntry: EdgeRenderableGroups = { pathGroup: edgeGroup };

    if (edge.label) {
      const labelGroup = new Group({ hittable: false }) as RenderableGroup;
      labelGroup.visible = true;
      drawEdgeLabel(labelGroup, edge.label);
      labelLayer.add(labelGroup);
      edgeRenderables.push({ id: edge.id, group: labelGroup });
      edgeEntry.labelGroup = labelGroup;
    }
    edgeGroups.set(edge.id, edgeEntry);
  }

  for (const node of sceneModel.nodes) {
    const nodeGroup = new Group({ hittable: false }) as RenderableGroup;
    nodeGroup.visible = true;
    drawNodeContents(nodeGroup, node, styles);
    nodeLayer.add(nodeGroup);
    nodeRenderables.push({ id: node.id, group: nodeGroup });
    nodeGroups.set(node.id, nodeGroup);
  }

  return { layers, nodeRenderables, edgeRenderables, nodeGroups, edgeGroups };
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function sceneStructureSignature(sceneModel: GraphSceneModel): string {
  const nodeSignature = sceneModel.nodes
    .map((node) => [
      node.id,
      node.kind,
      node.x,
      node.y,
      node.width,
      node.height,
    ].join(SIGNATURE_FIELD_SEPARATOR))
    .join(SIGNATURE_ITEM_SEPARATOR);
  const edgeSignature = sceneModel.edges
    .map((edge) => [
      edge.id,
      edge.source,
      edge.target,
      edge.label ? "label" : "no-label",
    ].join(SIGNATURE_FIELD_SEPARATOR))
    .join(SIGNATURE_ITEM_SEPARATOR);
  return [sceneModel.level, nodeSignature, edgeSignature].join(SIGNATURE_SECTION_SEPARATOR);
}

function nodeVisualSignature(node: GraphSceneNode): string {
  return stableJson({
    data: node.data,
    state: node.state,
  });
}

function edgeVisualSignature(edge: GraphSceneEdge): string {
  return stableJson({
    label: edge.label,
    labelStyle: edge.labelStyle,
    state: edge.state,
    style: edge.style,
  });
}

function nodeVisualSignatures(sceneModel: GraphSceneModel): Map<string, string> {
  return new Map(sceneModel.nodes.map((node) => [node.id, nodeVisualSignature(node)]));
}

function edgeVisualSignatures(sceneModel: GraphSceneModel): Map<string, string> {
  return new Map(sceneModel.edges.map((edge) => [edge.id, edgeVisualSignature(edge)]));
}

function redrawNodeRenderable(
  group: RenderableGroup,
  node: GraphSceneNode,
  styles: CSSStyleDeclaration,
): void {
  group.removeAll(true);
  drawNodeContents(group, node, styles);
}

function redrawEdgeRenderable(
  groups: EdgeRenderableGroups,
  edge: GraphSceneEdge,
  nodesById: ReadonlyMap<string, GraphSceneNode>,
): void {
  const [edgeSpec] = buildEdgePaintSpecs([edge], nodesById);
  groups.pathGroup.removeAll(true);
  groups.labelGroup?.removeAll(true);
  if (!edgeSpec) return;

  drawEdgePath(groups.pathGroup, edgeSpec);
  if (edgeSpec.label && groups.labelGroup) {
    drawEdgeLabel(groups.labelGroup, edgeSpec.label);
  }
}

export function createGraphRendererController({
  host,
  sceneModel,
  callbacks,
}: CreateGraphRendererControllerOptions): GraphRendererController {
  const styles = getComputedStyle(document.documentElement);
  const leafer = new Leafer({
    view: host,
    fill: resolveCssValue("var(--color-root)", styles),
    start: true,
    hittable: false,
  });
  const root = new Group({ hittable: false });
  let currentSceneModel = sceneModel;
  let hitIndex = buildGraphSceneHitIndex(currentSceneModel.nodes, 160);
  let viewport = fitCanvasSceneNodes(
    currentSceneModel.nodes,
    host.clientWidth,
    host.clientHeight,
    FIT_PADDING,
  );
  let hasUserMovedViewport = false;
  let frameId: number | null = null;
  let dragStart: CanvasPoint | null = null;
  let dragViewport: CanvasViewport | null = null;
  let didDrag = false;

  leafer.add(root);
  let renderables = drawScene(root, currentSceneModel, styles);
  let currentStructureSignature = sceneStructureSignature(currentSceneModel);
  let currentNodeVisualSignatures = nodeVisualSignatures(currentSceneModel);
  let currentEdgeVisualSignatures = edgeVisualSignatures(currentSceneModel);

  function rebuildSceneRenderables(nextSceneModel: GraphSceneModel): void {
    currentSceneModel = nextSceneModel;
    currentStructureSignature = sceneStructureSignature(currentSceneModel);
    currentNodeVisualSignatures = nodeVisualSignatures(currentSceneModel);
    currentEdgeVisualSignatures = edgeVisualSignatures(currentSceneModel);
    hitIndex = buildGraphSceneHitIndex(currentSceneModel.nodes, 160);
    root.removeAll(true);
    renderables = drawScene(root, currentSceneModel, styles);
  }

  function updateSceneRenderables(nextSceneModel: GraphSceneModel): void {
    currentSceneModel = nextSceneModel;
    const nextNodesById = new Map(currentSceneModel.nodes.map((node) => [node.id, node]));

    for (const node of currentSceneModel.nodes) {
      const nextSignature = nodeVisualSignature(node);
      if (currentNodeVisualSignatures.get(node.id) === nextSignature) continue;
      const group = renderables.nodeGroups.get(node.id);
      if (!group) {
        rebuildSceneRenderables(nextSceneModel);
        return;
      }
      redrawNodeRenderable(group, node, styles);
      currentNodeVisualSignatures.set(node.id, nextSignature);
    }

    for (const edge of currentSceneModel.edges) {
      const nextSignature = edgeVisualSignature(edge);
      if (currentEdgeVisualSignatures.get(edge.id) === nextSignature) continue;
      const groups = renderables.edgeGroups.get(edge.id);
      if (!groups) {
        rebuildSceneRenderables(nextSceneModel);
        return;
      }
      redrawEdgeRenderable(groups, edge, nextNodesById);
      currentEdgeVisualSignatures.set(edge.id, nextSignature);
    }
  }

  function applyVisibility(): void {
    const visibleItems = getVisibleGraphSceneItems({
      sceneModel: currentSceneModel,
      viewport,
      hostWidth: host.clientWidth,
      hostHeight: host.clientHeight,
      padding: CULLING_PADDING,
    });

    applyGraphSceneRenderableVisibility(
      renderables.nodeRenderables,
      visibleItems.visibleNodeIds,
    );
    applyGraphSceneRenderableVisibility(
      renderables.edgeRenderables,
      visibleItems.visibleEdgeIds,
    );
  }

  function renderViewport(): void {
    root.set({
      x: viewport.x,
      y: viewport.y,
      scaleX: viewport.zoom,
      scaleY: viewport.zoom,
    });
    applyVisibility();
  }

  function requestViewportRender(): void {
    if (frameId !== null) return;
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      renderViewport();
    });
  }

  function fitView(): void {
    viewport = fitCanvasSceneNodes(
      currentSceneModel.nodes,
      host.clientWidth,
      host.clientHeight,
      FIT_PADDING,
    );
    renderViewport();
    callbacks.onViewportChange?.(viewport, "programmatic");
  }

  function fitNodes(nodeIds: readonly string[]): void {
    const requestedIds = new Set(nodeIds);
    const nodes = currentSceneModel.nodes.filter((node) => requestedIds.has(node.id));
    if (nodes.length === 0) return;
    viewport = fitCanvasSceneNodes(nodes, host.clientWidth, host.clientHeight, FIT_PADDING);
    renderViewport();
    callbacks.onViewportChange?.(viewport, "programmatic");
  }

  function setCenter(x: number, y: number, options?: { zoom?: number }): void {
    viewport = centerCanvasViewportOn(
      { x, y },
      host.clientWidth,
      host.clientHeight,
      options?.zoom ?? viewport.zoom,
    );
    renderViewport();
    callbacks.onViewportChange?.(viewport, "programmatic");
  }

  function zoomBy(factor: number): void {
    viewport = zoomCanvasViewportAt(
      viewport,
      { x: host.clientWidth / 2, y: host.clientHeight / 2 },
      factor,
      MIN_ZOOM,
      MAX_ZOOM,
    );
    renderViewport();
    callbacks.onViewportChange?.(viewport, "programmatic");
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    hasUserMovedViewport = true;
    viewport = zoomCanvasViewportAt(
      viewport,
      hostPoint(host, event),
      Math.exp(-event.deltaY * 0.001),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    requestViewportRender();
    callbacks.onViewportChange?.(viewport, "user");
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
      return;
    }

    host.style.cursor = nodeAtPoint(host, viewport, hitIndex, event) ? "pointer" : "grab";
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
    const node = nodeAtPoint(host, viewport, hitIndex, event);
    if (node) {
      callbacks.onNodeClick(node);
      return;
    }
    callbacks.onPaneClick();
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    const node = nodeAtPoint(host, viewport, hitIndex, event);
    if (node) {
      callbacks.onNodeContextMenu?.(node, event.clientX, event.clientY);
      return;
    }
    callbacks.onPaneContextMenu?.();
  }

  function updateScene(nextSceneModel: GraphSceneModel): void {
    const nextStructureSignature = sceneStructureSignature(nextSceneModel);
    if (nextStructureSignature !== currentStructureSignature) {
      rebuildSceneRenderables(nextSceneModel);
    } else {
      updateSceneRenderables(nextSceneModel);
    }
    renderViewport();
  }

  const resizeObserver = new ResizeObserver(() => {
    if (hasUserMovedViewport) return;
    fitView();
  });

  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
  host.addEventListener("pointercancel", onPointerUp);
  host.addEventListener("click", onClick);
  host.addEventListener("contextmenu", onContextMenu);
  resizeObserver.observe(host);
  renderViewport();

  return {
    fitView,
    fitNodes,
    setCenter,
    zoomBy,
    updateScene,
    getViewport() {
      return viewport;
    },
    getSceneSnapshot() {
      return currentSceneModel;
    },
    destroy() {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      resizeObserver.disconnect();
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      host.removeEventListener("click", onClick);
      host.removeEventListener("contextmenu", onContextMenu);
      leafer.destroy();
    },
  };
}
