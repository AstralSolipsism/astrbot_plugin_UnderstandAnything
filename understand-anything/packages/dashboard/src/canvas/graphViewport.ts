import type { CanvasBounds, CanvasPoint } from "./graphTypes";
import type { GraphSceneNode } from "../graph-scene/graphSceneTypes";

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export function clampZoom(zoom: number, minZoom: number, maxZoom: number): number {
  if (!Number.isFinite(zoom)) return minZoom;
  return Math.min(maxZoom, Math.max(minZoom, zoom));
}

export function screenToWorldPoint(
  viewport: CanvasViewport,
  point: CanvasPoint,
): CanvasPoint {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

export function fitCanvasBounds(
  bounds: CanvasBounds,
  hostWidth: number,
  hostHeight: number,
  padding = 64,
): CanvasViewport {
  if (hostWidth <= 0 || hostHeight <= 0 || bounds.width <= 0 || bounds.height <= 0) {
    return { x: padding, y: padding, zoom: 1 };
  }

  const availableWidth = Math.max(1, hostWidth - padding * 2);
  const availableHeight = Math.max(1, hostHeight - padding * 2);
  const zoom = Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
  const graphWidth = bounds.width * zoom;
  const graphHeight = bounds.height * zoom;

  return {
    x: (hostWidth - graphWidth) / 2 - bounds.minX * zoom,
    y: (hostHeight - graphHeight) / 2 - bounds.minY * zoom,
    zoom,
  };
}

export function boundsForSceneNodes(nodes: readonly GraphSceneNode[]): CanvasBounds {
  if (nodes.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function fitCanvasSceneNodes(
  nodes: readonly GraphSceneNode[],
  hostWidth: number,
  hostHeight: number,
  padding = 64,
): CanvasViewport {
  return fitCanvasBounds(boundsForSceneNodes(nodes), hostWidth, hostHeight, padding);
}

export function centerCanvasViewportOn(
  center: CanvasPoint,
  hostWidth: number,
  hostHeight: number,
  zoom: number,
): CanvasViewport {
  return {
    x: hostWidth / 2 - center.x * zoom,
    y: hostHeight / 2 - center.y * zoom,
    zoom,
  };
}

export function zoomCanvasViewportAt(
  viewport: CanvasViewport,
  anchor: CanvasPoint,
  zoomFactor: number,
  minZoom: number,
  maxZoom: number,
): CanvasViewport {
  const nextZoom = clampZoom(viewport.zoom * zoomFactor, minZoom, maxZoom);
  const worldAnchor = screenToWorldPoint(viewport, anchor);

  return {
    x: anchor.x - worldAnchor.x * nextZoom,
    y: anchor.y - worldAnchor.y * nextZoom,
    zoom: nextZoom,
  };
}
