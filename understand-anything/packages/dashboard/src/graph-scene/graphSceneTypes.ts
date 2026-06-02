import type { Complexity } from "../utils/layerStats";

export type GraphSceneLevel = "overview" | "layer-detail";
export type GraphSceneNodeKind = "layer-cluster" | "custom" | "container" | "portal";

export interface GraphSceneNodeState {
  selected: boolean;
  highlighted: boolean;
  searchMatched: boolean;
  diffChanged: boolean;
  diffAffected: boolean;
  faded: boolean;
  focused: boolean;
}

export interface GraphSceneLayerClusterData extends Record<string, unknown> {
  layerId: string;
  layerName: string;
  layerDescription: string;
  fileCount: number;
  aggregateComplexity: Complexity;
  layerColorIndex: number;
  searchMatchCount?: number;
}

export interface GraphSceneNode {
  id: string;
  kind: GraphSceneNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  data: Record<string, unknown>;
  state: GraphSceneNodeState;
}

export interface GraphSceneEdgeStyle {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
}

export interface GraphSceneEdgeLabelStyle {
  fill: string;
  fontSize: number;
  fontWeight: number;
}

export interface GraphSceneEdgeState {
  selected: boolean;
  faded: boolean;
  highlighted: boolean;
}

export interface GraphSceneEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  style: GraphSceneEdgeStyle;
  labelStyle?: GraphSceneEdgeLabelStyle;
  state: GraphSceneEdgeState;
}

export interface GraphSceneModel {
  level: GraphSceneLevel;
  nodes: GraphSceneNode[];
  edges: GraphSceneEdge[];
}

export interface GraphScenePoint {
  x: number;
  y: number;
}

export const DEFAULT_GRAPH_SCENE_NODE_STATE: GraphSceneNodeState = {
  selected: false,
  highlighted: false,
  searchMatched: false,
  diffChanged: false,
  diffAffected: false,
  faded: false,
  focused: false,
};

export const DEFAULT_GRAPH_SCENE_EDGE_STATE: GraphSceneEdgeState = {
  selected: false,
  faded: false,
  highlighted: false,
};
