import type { EdgePaintSpec } from "./renderEdges";

export const GRAPH_RENDER_LAYER_ORDER = [
  "background",
  "edge",
  "label",
  "node",
] as const;

export type GraphRenderLayerName = (typeof GRAPH_RENDER_LAYER_ORDER)[number];

export interface EdgeLabelTextPaintOptions {
  x: number;
  y: number;
  text: string;
  fill: string;
  fontSize: number;
  fontWeight?: number;
  hittable: false;
}

export function buildEdgeLabelTextPaintOptions(
  label: NonNullable<EdgePaintSpec["label"]>,
): EdgeLabelTextPaintOptions {
  return {
    x: label.x,
    y: label.y,
    text: label.text,
    fill: label.fill,
    fontSize: label.fontSize,
    fontWeight: label.fontWeight,
    hittable: false,
  };
}
