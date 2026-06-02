import type { GraphSceneLayerClusterData, GraphSceneNode } from "../graph-scene/graphSceneTypes";
import { getBaselineLayerColor } from "../graph-scene/graphSceneStyles";

export interface RectPaintSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  cornerRadius?: number;
}

export interface TextPaintSpec {
  x: number;
  y: number;
  text: string;
  fill: string;
  fontSize: number;
  fontWeight?: number;
  width?: number;
}

export interface LayerClusterPaintSpec {
  card: RectPaintSpec;
  strip: RectPaintSpec;
  texts: TextPaintSpec[];
}

const complexityLabels: Record<string, string> = {
  simple: "简单",
  moderate: "中等",
  complex: "复杂",
};

const complexityColors: Record<string, string> = {
  simple: "var(--color-node-function)",
  moderate: "var(--color-gold-dim)",
  complex: "#c97070",
};

function asLayerClusterData(node: GraphSceneNode): Partial<GraphSceneLayerClusterData> {
  return node.data as Partial<GraphSceneLayerClusterData>;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function buildLayerClusterPaintSpec(node: GraphSceneNode): LayerClusterPaintSpec {
  const data = asLayerClusterData(node);
  const color = getBaselineLayerColor(numberValue(data.layerColorIndex, 0));
  const complexity = textValue(data.aggregateComplexity, "simple");
  const complexityLabel = complexityLabels[complexity] ?? complexity;
  const fileCount = numberValue(data.fileCount, 0);
  const searchMatchCount = numberValue(data.searchMatchCount, 0);
  const headerY = node.y + 18;

  const texts: TextPaintSpec[] = [
    {
      x: node.x + 20,
      y: headerY,
      text: "层级",
      fill: color.label,
      fontSize: 10,
      fontWeight: 600,
    },
    {
      x: node.x + node.width - 56,
      y: headerY,
      text: complexityLabel,
      fill: complexityColors[complexity] ?? complexityColors.simple,
      fontSize: 10,
      fontWeight: 600,
    },
  ];

  if (searchMatchCount > 0) {
    texts.push({
      x: node.x + node.width - 124,
      y: headerY,
      text: `命中 ${searchMatchCount}`,
      fill: "var(--color-gold)",
      fontSize: 10,
      fontWeight: 600,
    });
  }

  texts.push(
    {
      x: node.x + 20,
      y: node.y + 48,
      text: textValue(data.layerName, "未命名层级"),
      fill: "var(--color-text-primary)",
      fontSize: 18,
      fontWeight: 400,
      width: node.width - 40,
    },
    {
      x: node.x + 20,
      y: node.y + 78,
      text: textValue(data.layerDescription, ""),
      fill: "var(--color-text-secondary)",
      fontSize: 11,
      width: node.width - 40,
    },
    {
      x: node.x + 20,
      y: node.y + node.height - 32,
      text: `${fileCount} 个文件`,
      fill: "var(--color-text-muted)",
      fontSize: 11,
    },
    {
      x: node.x + node.width - 82,
      y: node.y + node.height - 32,
      text: "点击查看 →",
      fill: "var(--color-text-muted)",
      fontSize: 10,
    },
  );

  return {
    card: {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      fill: "var(--color-elevated)",
      stroke: "var(--color-border-subtle)",
      strokeWidth: 1,
      cornerRadius: 12,
    },
    strip: {
      x: node.x,
      y: node.y,
      width: 6,
      height: node.height,
      fill: color.label,
      cornerRadius: 12,
    },
    texts,
  };
}
