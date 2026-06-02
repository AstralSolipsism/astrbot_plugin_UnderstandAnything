import type { GraphSceneNode } from "../graph-scene/graphSceneTypes";
import { getBaselineLayerColor } from "../graph-scene/graphSceneStyles";
import type { RectPaintSpec, TextPaintSpec } from "./renderLayerCluster";

export interface ContainerNodePaintSpec {
  card: RectPaintSpec;
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

function booleanData(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true;
}

export function buildContainerNodePaintSpec(node: GraphSceneNode): ContainerNodePaintSpec {
  const color = getBaselineLayerColor(numberData(node.data, "colorIndex", 0));
  const isExpanded = booleanData(node.data, "isExpanded");
  const label = stringData(node.data, "name", "根目录") === "~"
    ? "根目录"
    : stringData(node.data, "name", "根目录");
  const searchHitCount = numberData(node.data, "searchHitCount", 0);
  const isEmphasized = isExpanded || booleanData(node.data, "isFocusedViaChild") || node.state.focused;
  const isDiffAffected = booleanData(node.data, "isDiffAffected") || node.state.diffAffected;

  const texts: TextPaintSpec[] = [
    {
      x: node.x + 16,
      y: node.y + 12,
      text: `${isExpanded ? "▾ " : ""}${label}`,
      fill: color.label,
      fontSize: 14,
      fontWeight: 400,
      width: node.width - 96,
    },
  ];

  if (searchHitCount > 0) {
    texts.push({
      x: node.x + 92,
      y: node.y + 14,
      text: `命中 ${searchHitCount}`,
      fill: "var(--color-gold)",
      fontSize: 10,
      fontWeight: 600,
    });
  }

  texts.push({
    x: node.x + node.width - 34,
    y: node.y + 14,
    text: String(numberData(node.data, "childCount", 0)),
    fill: "var(--color-text-secondary)",
    fontSize: 11,
  });

  return {
    card: {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      fill: "rgba(255,255,255,0.02)",
      stroke: isDiffAffected
        ? "var(--color-diff-changed)"
        : isEmphasized
          ? "rgba(212,165,116,0.6)"
          : "rgba(212,165,116,0.25)",
      strokeWidth: isEmphasized ? 1.5 : 1,
      cornerRadius: 12,
    },
    texts,
  };
}
