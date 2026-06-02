import type { KnowledgeGraph, NodeType } from "@understand-anything/core/types";
import type {
  CanvasBounds,
  CanvasGraphEdge,
  CanvasGraphModel,
  CanvasGraphNode,
} from "./graphTypes";

const LAYER_SPACING_X = 900;
const NODE_SPACING_X = 112;
const NODE_SPACING_Y = 112;
const GROUP_TOP_Y = 0;
const GROUP_LEFT_X = 0;

const NODE_TYPE_COLORS: Partial<Record<NodeType, string>> = {
  file: "#3b82f6",
  module: "#2563eb",
  function: "#10b981",
  class: "#14b8a6",
  concept: "#8b5cf6",
  config: "#f59e0b",
  document: "#64748b",
  service: "#ef4444",
  endpoint: "#f97316",
  table: "#06b6d4",
  schema: "#0ea5e9",
  domain: "#7c3aed",
  flow: "#a855f7",
  step: "#c084fc",
  article: "#84cc16",
  entity: "#22c55e",
  topic: "#eab308",
  claim: "#f43f5e",
  source: "#6b7280",
};

const NODE_TYPE_RADII: Partial<Record<NodeType, number>> = {
  domain: 10,
  flow: 9,
  service: 9,
  endpoint: 8,
  class: 8,
  module: 8,
  file: 7,
};

interface NodeLayerAssignment {
  layerId: string | null;
  layerIndex: number;
}

interface LayerBucket {
  id: string | null;
  index: number;
  nodeIds: string[];
}

function colorForNodeType(type: NodeType): string {
  return NODE_TYPE_COLORS[type] ?? "#94a3b8";
}

function radiusForNodeType(type: NodeType): number {
  return NODE_TYPE_RADII[type] ?? 6;
}

function buildLayerAssignments(graph: KnowledgeGraph): Map<string, NodeLayerAssignment> {
  const assignments = new Map<string, NodeLayerAssignment>();

  graph.layers.forEach((layer, layerIndex) => {
    for (const nodeId of layer.nodeIds) {
      if (assignments.has(nodeId)) continue;
      assignments.set(nodeId, {
        layerId: layer.id,
        layerIndex,
      });
    }
  });

  return assignments;
}

function buildLayerBuckets(graph: KnowledgeGraph): LayerBucket[] {
  const explicitBuckets: LayerBucket[] = graph.layers.map((layer, index) => ({
    id: layer.id,
    index,
    nodeIds: [],
  }));
  const bucketById = new Map(explicitBuckets.map((bucket) => [bucket.id, bucket]));
  const assignments = buildLayerAssignments(graph);
  const fallbackBucket: LayerBucket = {
    id: null,
    index: graph.layers.length,
    nodeIds: [],
  };

  for (const node of graph.nodes) {
    const assignment = assignments.get(node.id);
    const bucket = assignment?.layerId ? bucketById.get(assignment.layerId) : fallbackBucket;
    bucket?.nodeIds.push(node.id);
  }

  for (const bucket of explicitBuckets) {
    bucket.nodeIds.sort();
  }
  fallbackBucket.nodeIds.sort();

  return fallbackBucket.nodeIds.length > 0 ? [...explicitBuckets, fallbackBucket] : explicitBuckets;
}

function computeBounds(nodes: CanvasGraphNode[]): CanvasBounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function buildCanvasGraphModel(graph: KnowledgeGraph): CanvasGraphModel {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const layerAssignments = buildLayerAssignments(graph);
  const buckets = buildLayerBuckets(graph);
  const nodes: CanvasGraphNode[] = [];

  buckets.forEach((bucket, bucketIndex) => {
    const columns = Math.max(1, Math.ceil(Math.sqrt(bucket.nodeIds.length)));
    const baseX = GROUP_LEFT_X + bucketIndex * LAYER_SPACING_X;

    bucket.nodeIds.forEach((nodeId, nodeIndex) => {
      const sourceNode = nodeById.get(nodeId);
      if (!sourceNode) return;
      const column = nodeIndex % columns;
      const row = Math.floor(nodeIndex / columns);
      const assignment = layerAssignments.get(nodeId) ?? {
        layerId: null,
        layerIndex: graph.layers.length,
      };

      nodes.push({
        id: sourceNode.id,
        label: sourceNode.name,
        nodeType: sourceNode.type,
        layerId: assignment.layerId,
        layerIndex: assignment.layerIndex,
        x: baseX + column * NODE_SPACING_X,
        y: GROUP_TOP_Y + row * NODE_SPACING_Y,
        radius: radiusForNodeType(sourceNode.type),
        color: colorForNodeType(sourceNode.type),
      });
    });
  });

  const canvasNodeIds = new Set(nodes.map((node) => node.id));
  const edges: CanvasGraphEdge[] = [];

  graph.edges.forEach((edge, edgeIndex) => {
    if (!canvasNodeIds.has(edge.source) || !canvasNodeIds.has(edge.target)) return;
    edges.push({
      id: `${edge.source}->${edge.target}:${edge.type}:${edgeIndex}`,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      weight: edge.weight,
    });
  });

  return {
    nodes,
    edges,
    bounds: computeBounds(nodes),
  };
}
