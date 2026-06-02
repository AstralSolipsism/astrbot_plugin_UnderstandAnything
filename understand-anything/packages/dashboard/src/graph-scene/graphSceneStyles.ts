import type { GraphSceneEdgeLabelStyle, GraphSceneEdgeStyle } from "./graphSceneTypes";

export const BASELINE_LAYER_PALETTE = [
  { bg: "rgba(74, 124, 155, 0.12)", border: "rgba(74, 124, 155, 0.4)", label: "#4a7c9b" },
  { bg: "rgba(90, 158, 111, 0.12)", border: "rgba(90, 158, 111, 0.4)", label: "#5a9e6f" },
  { bg: "rgba(139, 111, 176, 0.12)", border: "rgba(139, 111, 176, 0.4)", label: "#8b6fb0" },
  { bg: "rgba(201, 160, 108, 0.12)", border: "rgba(201, 160, 108, 0.4)", label: "#c9a06c" },
  { bg: "rgba(176, 122, 138, 0.12)", border: "rgba(176, 122, 138, 0.4)", label: "#b07a8a" },
  { bg: "rgba(74, 155, 140, 0.12)", border: "rgba(74, 155, 140, 0.4)", label: "#4a9b8c" },
  { bg: "rgba(120, 130, 145, 0.12)", border: "rgba(120, 130, 145, 0.4)", label: "#788291" },
] as const;

export const BASELINE_LAYER_EDGE_STYLE = {
  stroke: "rgba(212,165,116,0.4)",
} as const;

export const BASELINE_LAYER_EDGE_LABEL_STYLE: GraphSceneEdgeLabelStyle = {
  fill: "#a39787",
  fontSize: 11,
  fontWeight: 600,
};

export function layerEdgeStyleForCount(count: number): GraphSceneEdgeStyle {
  return {
    stroke: BASELINE_LAYER_EDGE_STYLE.stroke,
    strokeWidth: Math.min(1 + Math.log2(count + 1), 5),
  };
}

export function getBaselineLayerColor(index: number) {
  return BASELINE_LAYER_PALETTE[index % BASELINE_LAYER_PALETTE.length];
}
