import type { GraphSceneNode } from "../graph-scene/graphSceneTypes";
import { getBaselineLayerColor } from "../graph-scene/graphSceneStyles";
import type { RectPaintSpec, TextPaintSpec } from "./renderLayerCluster";

export interface PortalNodePaintSpec {
  card: RectPaintSpec;
  dot: RectPaintSpec;
  texts: TextPaintSpec[];
}

function stringData(data: Record<string, unknown>, key: string, fallback: string): string {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberData(data: Record<string, unknown>, key: string, fallback: number): number {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function buildPortalNodePaintSpec(node: GraphSceneNode): PortalNodePaintSpec {
  const color = getBaselineLayerColor(numberData(node.data, "layerColorIndex", 0));
  const connectionCount = numberData(node.data, "connectionCount", 0);

  return {
    card: {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      fill: "rgba(26,26,26,0.6)",
      stroke: color.border,
      strokeWidth: 2,
      cornerRadius: 8,
    },
    dot: {
      x: node.x + 14,
      y: node.y + 29,
      width: 8,
      height: 8,
      fill: color.label,
      cornerRadius: 4,
    },
    texts: [
      {
        x: node.x + 30,
        y: node.y + 22,
        text: stringData(node.data, "targetLayerName", "目标层级"),
        fill: "var(--color-text-primary)",
        fontSize: 14,
        width: node.width - 72,
      },
      {
        x: node.x + node.width - 28,
        y: node.y + 22,
        text: "→",
        fill: "var(--color-text-muted)",
        fontSize: 14,
      },
      {
        x: node.x + 30,
        y: node.y + 48,
        text: `${connectionCount} 个连接`,
        fill: "var(--color-text-muted)",
        fontSize: 10,
      },
    ],
  };
}
