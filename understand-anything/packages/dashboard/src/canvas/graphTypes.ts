import type { EdgeType, NodeType } from "@understand-anything/core/types";

export interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface CanvasGraphNode {
  id: string;
  label: string;
  nodeType: NodeType;
  layerId: string | null;
  layerIndex: number;
  x: number;
  y: number;
  radius: number;
  color: string;
}

export interface CanvasGraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  weight: number;
}

export interface CanvasGraphModel {
  nodes: CanvasGraphNode[];
  edges: CanvasGraphEdge[];
  bounds: CanvasBounds;
}

export interface CanvasPoint {
  x: number;
  y: number;
}
