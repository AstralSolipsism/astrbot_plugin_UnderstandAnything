import type { KnowledgeGraph } from "@understand-anything/core/types";
import {
  LAYER_CLUSTER_HEIGHT,
  LAYER_CLUSTER_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  PORTAL_NODE_HEIGHT,
  PORTAL_NODE_WIDTH,
} from "../utils/layout";
import { aggregateLayerEdges } from "../utils/edgeAggregation";
import { computeLayerStats } from "../utils/layerStats";
import {
  BASELINE_LAYER_EDGE_LABEL_STYLE,
  layerEdgeStyleForCount,
} from "./graphSceneStyles";
import {
  DEFAULT_GRAPH_SCENE_EDGE_STATE,
  DEFAULT_GRAPH_SCENE_NODE_STATE,
  type GraphSceneEdge,
  type GraphSceneEdgeLabelStyle,
  type GraphSceneEdgeStyle,
  type GraphSceneLevel,
  type GraphSceneModel,
  type GraphSceneNodeKind,
  type GraphScenePoint,
} from "./graphSceneTypes";

export interface BuildOverviewSceneModelOptions {
  graph: KnowledgeGraph;
  searchResultNodeIds?: ReadonlySet<string>;
  positions?: ReadonlyMap<string, GraphScenePoint>;
}

export interface GraphSceneFlowNodeInput {
  id: string;
  type?: string;
  parentId?: string;
  position?: GraphScenePoint;
  width?: number;
  height?: number;
  style?: {
    width?: number | string;
    height?: number | string;
  };
  data?: Record<string, unknown>;
}

export interface GraphSceneFlowEdgeInput {
  id?: string;
  source: string;
  target: string;
  label?: string | number;
  style?: {
    stroke?: string;
    strokeWidth?: number;
    strokeDasharray?: string;
  };
  labelStyle?: {
    fill?: string;
    fontSize?: number;
    fontWeight?: number;
  };
}

export interface BuildGraphSceneModelFromFlowOptions {
  level: GraphSceneLevel;
  nodes: readonly GraphSceneFlowNodeInput[];
  edges: readonly GraphSceneFlowEdgeInput[];
}

function buildNodeToLayerId(graph: KnowledgeGraph): Map<string, string> {
  const nodeToLayerId = new Map<string, string>();
  for (const layer of graph.layers) {
    for (const nodeId of layer.nodeIds) {
      nodeToLayerId.set(nodeId, layer.id);
    }
  }
  return nodeToLayerId;
}

function buildSearchMatchCounts(
  graph: KnowledgeGraph,
  searchResultNodeIds?: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!searchResultNodeIds || searchResultNodeIds.size === 0) return counts;

  const nodeToLayerId = buildNodeToLayerId(graph);
  for (const nodeId of searchResultNodeIds) {
    const layerId = nodeToLayerId.get(nodeId);
    if (!layerId) continue;
    counts.set(layerId, (counts.get(layerId) ?? 0) + 1);
  }
  return counts;
}

export function buildOverviewSceneModel({
  graph,
  searchResultNodeIds,
  positions,
}: BuildOverviewSceneModelOptions): GraphSceneModel {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const searchMatchByLayer = buildSearchMatchCounts(graph, searchResultNodeIds);

  const nodes = graph.layers.map((layer, layerIndex) => {
    const position = positions?.get(layer.id) ?? { x: 0, y: 0 };
    const { aggregateComplexity } = computeLayerStats(layer, nodesById);
    const searchMatchCount = searchMatchByLayer.get(layer.id);

    return {
      id: layer.id,
      kind: "layer-cluster" as const,
      x: position.x,
      y: position.y,
      width: LAYER_CLUSTER_WIDTH,
      height: LAYER_CLUSTER_HEIGHT,
      data: {
        layerId: layer.id,
        layerName: layer.name,
        layerDescription: layer.description,
        fileCount: layer.nodeIds.length,
        aggregateComplexity,
        layerColorIndex: layerIndex,
        ...(searchMatchCount ? { searchMatchCount } : {}),
      },
      state: {
        ...DEFAULT_GRAPH_SCENE_NODE_STATE,
        searchMatched: Boolean(searchMatchCount),
      },
    };
  });

  const edges = aggregateLayerEdges(graph).map((edge, edgeIndex) => ({
    id: `le-${edgeIndex}`,
    source: edge.sourceLayerId,
    target: edge.targetLayerId,
    label: `${edge.count}`,
    style: layerEdgeStyleForCount(edge.count),
    labelStyle: BASELINE_LAYER_EDGE_LABEL_STYLE,
    state: { ...DEFAULT_GRAPH_SCENE_EDGE_STATE },
  }));

  return {
    level: "overview",
    nodes,
    edges,
  };
}

function sceneKindForFlowType(type: string | undefined): GraphSceneNodeKind {
  if (type === "layer-cluster" || type === "container" || type === "portal") {
    return type;
  }
  return "custom";
}

function numericDimension(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fallbackWidthForKind(kind: GraphSceneNodeKind): number {
  if (kind === "layer-cluster") return LAYER_CLUSTER_WIDTH;
  if (kind === "portal") return PORTAL_NODE_WIDTH;
  return NODE_WIDTH;
}

function fallbackHeightForKind(kind: GraphSceneNodeKind): number {
  if (kind === "layer-cluster") return LAYER_CLUSTER_HEIGHT;
  if (kind === "portal") return PORTAL_NODE_HEIGHT;
  return NODE_HEIGHT;
}

function nodeWidth(node: GraphSceneFlowNodeInput, kind: GraphSceneNodeKind): number {
  return (
    numericDimension(node.width) ??
    numericDimension(node.style?.width) ??
    fallbackWidthForKind(kind)
  );
}

function nodeHeight(node: GraphSceneFlowNodeInput, kind: GraphSceneNodeKind): number {
  return (
    numericDimension(node.height) ??
    numericDimension(node.style?.height) ??
    fallbackHeightForKind(kind)
  );
}

function booleanData(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true;
}

function hasPositiveNumberData(data: Record<string, unknown>, key: string): boolean {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sceneEdgeStyle(style: GraphSceneFlowEdgeInput["style"]): GraphSceneEdgeStyle {
  return {
    stroke: style?.stroke ?? "rgba(212,165,116,0.5)",
    strokeWidth: style?.strokeWidth ?? 1.5,
    ...(style?.strokeDasharray ? { strokeDasharray: style.strokeDasharray } : {}),
  };
}

function sceneEdgeLabelStyle(
  labelStyle: GraphSceneFlowEdgeInput["labelStyle"],
): GraphSceneEdgeLabelStyle | undefined {
  if (!labelStyle) return undefined;
  return {
    fill: labelStyle.fill ?? "#a39787",
    fontSize: labelStyle.fontSize ?? 10,
    fontWeight: labelStyle.fontWeight ?? 400,
  };
}

export function buildGraphSceneModelFromFlow({
  level,
  nodes,
  edges,
}: BuildGraphSceneModelFromFlowOptions): GraphSceneModel {
  const flowNodeById = new Map(nodes.map((node) => [node.id, node]));

  const sceneNodes = nodes.map((node) => {
    const kind = sceneKindForFlowType(node.type);
    const data = node.data ?? {};
    const localPosition = node.position ?? { x: 0, y: 0 };
    const parentPosition = node.parentId
      ? flowNodeById.get(node.parentId)?.position ?? { x: 0, y: 0 }
      : { x: 0, y: 0 };
    const position = {
      x: parentPosition.x + localPosition.x,
      y: parentPosition.y + localPosition.y,
    };

    return {
      id: node.id,
      kind,
      x: position.x,
      y: position.y,
      width: nodeWidth(node, kind),
      height: nodeHeight(node, kind),
      data,
      state: {
        ...DEFAULT_GRAPH_SCENE_NODE_STATE,
        selected: booleanData(data, "isSelected"),
        highlighted: booleanData(data, "isHighlighted") || booleanData(data, "isTourHighlighted"),
        searchMatched:
          booleanData(data, "hasSearchHits") ||
          hasPositiveNumberData(data, "searchHitCount") ||
          hasPositiveNumberData(data, "searchScore"),
        diffChanged: booleanData(data, "isDiffChanged"),
        diffAffected: booleanData(data, "isDiffAffected"),
        faded: booleanData(data, "isDiffFaded") || booleanData(data, "isSelectionFaded"),
        focused: booleanData(data, "isFocusedViaChild") || booleanData(data, "isNeighbor"),
      },
    };
  });

  const sceneEdges: GraphSceneEdge[] = edges.map((edge, index) => ({
    id: edge.id ?? `edge-${index}`,
    source: edge.source,
    target: edge.target,
    ...(edge.label != null ? { label: String(edge.label) } : {}),
    style: sceneEdgeStyle(edge.style),
    labelStyle: sceneEdgeLabelStyle(edge.labelStyle),
    state: { ...DEFAULT_GRAPH_SCENE_EDGE_STATE },
  }));

  return {
    level,
    nodes: sceneNodes,
    edges: sceneEdges,
  };
}
