import type { GraphSceneModel, GraphSceneNode } from "../graph-scene/graphSceneTypes";
import { boundsForSceneNodes } from "./graphViewport";

export interface GraphSceneSvgExport {
  svgContent: string;
  width: number;
  height: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nodeLabel(node: GraphSceneNode): string {
  const candidates = [
    node.data.label,
    node.data.layerName,
    node.data.name,
    node.data.targetLayerName,
    node.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return node.id;
}

export function buildGraphSceneSvg(
  scene: GraphSceneModel,
  padding = 40,
): GraphSceneSvgExport | null {
  if (scene.nodes.length === 0) return null;

  const bounds = boundsForSceneNodes(scene.nodes);
  const width = bounds.width + padding * 2;
  const height = bounds.height + padding * 2;
  const offsetX = -bounds.minX + padding;
  const offsetY = -bounds.minY + padding;
  const nodesById = new Map(scene.nodes.map((node) => [node.id, node]));

  let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svgContent += `<rect width="100%" height="100%" fill="#0a0a0a"/>`;

  for (const edge of scene.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) continue;
    const sx = source.x + source.width / 2 + offsetX;
    const sy = source.y + source.height / 2 + offsetY;
    const tx = target.x + target.width / 2 + offsetX;
    const ty = target.y + target.height / 2 + offsetY;
    const labelX = (sx + tx) / 2;
    const labelY = (sy + ty) / 2;

    svgContent += `<line x1="${sx}" y1="${sy}" x2="${tx}" y2="${ty}" stroke="${escapeXml(edge.style.stroke)}" stroke-width="${edge.style.strokeWidth}"/>`;
    if (edge.label) {
      svgContent += `<text x="${labelX}" y="${labelY}" fill="${escapeXml(edge.labelStyle?.fill ?? "#a39787")}" text-anchor="middle" font-size="${edge.labelStyle?.fontSize ?? 11}" font-weight="${edge.labelStyle?.fontWeight ?? 600}">${escapeXml(edge.label)}</text>`;
    }
  }

  for (const node of scene.nodes) {
    const x = node.x + offsetX;
    const y = node.y + offsetY;
    const stroke = node.state.selected ? "#d4a574" : "rgba(212,165,116,0.2)";
    svgContent += `<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="8" fill="#1a1a1a" stroke="${stroke}" stroke-width="1"/>`;
    svgContent += `<text x="${x + node.width / 2}" y="${y + node.height / 2}" fill="#d4a574" text-anchor="middle" dominant-baseline="middle" font-size="12">${escapeXml(nodeLabel(node))}</text>`;
  }

  svgContent += `</svg>`;
  return { svgContent, width, height };
}
