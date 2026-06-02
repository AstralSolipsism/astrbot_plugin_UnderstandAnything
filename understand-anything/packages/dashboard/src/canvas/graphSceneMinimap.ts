import type { GraphSceneModel, GraphSceneNodeKind } from "../graph-scene/graphSceneTypes";
import {
  boundsForSceneNodes,
  screenToWorldPoint,
  type CanvasViewport,
} from "./graphViewport";
import type { CanvasBounds, CanvasPoint } from "./graphTypes";

export interface GraphSceneMiniMapItem {
  id: string;
  kind: GraphSceneNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  highlighted: boolean;
}

export interface GraphSceneMiniMap {
  width: number;
  height: number;
  viewBox: string;
  padding: number;
  scale: number;
  bounds: CanvasBounds;
  items: GraphSceneMiniMapItem[];
}

export interface GraphSceneMiniMapViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

function projectWorldX(minimap: GraphSceneMiniMap, x: number): number {
  return minimap.padding + (x - minimap.bounds.minX) * minimap.scale;
}

function projectWorldY(minimap: GraphSceneMiniMap, y: number): number {
  return minimap.padding + (y - minimap.bounds.minY) * minimap.scale;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildGraphSceneMiniMap(
  scene: GraphSceneModel,
  width: number,
  height: number,
  padding = 8,
): GraphSceneMiniMap {
  const bounds = boundsForSceneNodes(scene.nodes);
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const scale =
    bounds.width <= 0 || bounds.height <= 0
      ? 1
      : Math.min(availableWidth / bounds.width, availableHeight / bounds.height);

  return {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    padding,
    scale,
    bounds,
    items: scene.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      x: padding + (node.x - bounds.minX) * scale,
      y: padding + (node.y - bounds.minY) * scale,
      width: Math.max(2, node.width * scale),
      height: Math.max(2, node.height * scale),
      selected: node.state.selected,
      highlighted: node.state.highlighted || node.state.searchMatched || node.state.focused,
    })),
  };
}

export function projectViewportToMiniMap(
  minimap: GraphSceneMiniMap,
  viewport: CanvasViewport,
  hostWidth: number,
  hostHeight: number,
): GraphSceneMiniMapViewport {
  const topLeft = screenToWorldPoint(viewport, { x: 0, y: 0 });
  const bottomRight = screenToWorldPoint(viewport, { x: hostWidth, y: hostHeight });
  const worldMinX = Math.min(topLeft.x, bottomRight.x);
  const worldMinY = Math.min(topLeft.y, bottomRight.y);
  const worldMaxX = Math.max(topLeft.x, bottomRight.x);
  const worldMaxY = Math.max(topLeft.y, bottomRight.y);

  const innerMinX = minimap.padding;
  const innerMinY = minimap.padding;
  const innerMaxX = minimap.width - minimap.padding;
  const innerMaxY = minimap.height - minimap.padding;
  const x = clamp(projectWorldX(minimap, worldMinX), innerMinX, innerMaxX);
  const y = clamp(projectWorldY(minimap, worldMinY), innerMinY, innerMaxY);
  const maxX = clamp(projectWorldX(minimap, worldMaxX), innerMinX, innerMaxX);
  const maxY = clamp(projectWorldY(minimap, worldMaxY), innerMinY, innerMaxY);

  return {
    x,
    y,
    width: Math.max(4, maxX - x),
    height: Math.max(4, maxY - y),
  };
}

export function miniMapPointToScenePoint(
  minimap: GraphSceneMiniMap,
  point: CanvasPoint,
): CanvasPoint {
  if (minimap.scale <= 0) {
    return {
      x: minimap.bounds.minX,
      y: minimap.bounds.minY,
    };
  }

  const innerMinX = minimap.padding;
  const innerMinY = minimap.padding;
  const innerMaxX = minimap.width - minimap.padding;
  const innerMaxY = minimap.height - minimap.padding;
  return {
    x: minimap.bounds.minX + (clamp(point.x, innerMinX, innerMaxX) - minimap.padding) / minimap.scale,
    y: minimap.bounds.minY + (clamp(point.y, innerMinY, innerMaxY) - minimap.padding) / minimap.scale,
  };
}
