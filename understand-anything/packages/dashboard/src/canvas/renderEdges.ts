import type { GraphSceneEdge, GraphSceneNode } from "../graph-scene/graphSceneTypes";

export interface EdgePaintSpec {
  id: string;
  path: string;
  stroke: string;
  strokeWidth: number;
  dashPattern?: number[];
  label?: {
    x: number;
    y: number;
    text: string;
    fill: string;
    fontSize: number;
    fontWeight?: number;
  };
}

function nodeCenter(node: GraphSceneNode) {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

function parseDashPattern(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(/[,\s]+/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part) && part > 0);
  return parts.length > 0 ? parts : undefined;
}

export function buildEdgePaintSpecs(
  edges: readonly GraphSceneEdge[],
  nodesById: ReadonlyMap<string, GraphSceneNode>,
): EdgePaintSpec[] {
  const specs: EdgePaintSpec[] = [];

  for (const edge of edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) continue;

    const sourcePoint = {
      x: source.x + source.width / 2,
      y: source.y + source.height,
    };
    const targetPoint = {
      x: target.x + target.width / 2,
      y: target.y,
    };
    const sourceCenter = nodeCenter(source);
    const targetCenter = nodeCenter(target);
    const midY = (sourcePoint.y + targetPoint.y) / 2;
    const path = [
      `M ${sourcePoint.x} ${sourcePoint.y}`,
      `C ${sourcePoint.x} ${midY} ${targetPoint.x} ${midY} ${targetPoint.x} ${targetPoint.y}`,
    ].join(" ");

    specs.push({
      id: edge.id,
      path,
      stroke: edge.style.stroke,
      strokeWidth: edge.style.strokeWidth,
      dashPattern: parseDashPattern(edge.style.strokeDasharray),
      label: edge.label
        ? {
            x: (sourceCenter.x + targetCenter.x) / 2,
            y: (sourceCenter.y + targetCenter.y) / 2,
            text: edge.label,
            fill: edge.labelStyle?.fill ?? "#a39787",
            fontSize: edge.labelStyle?.fontSize ?? 11,
            fontWeight: edge.labelStyle?.fontWeight,
          }
        : undefined,
    });
  }

  return specs;
}
