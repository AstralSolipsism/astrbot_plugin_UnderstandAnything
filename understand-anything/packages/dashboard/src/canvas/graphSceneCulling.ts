import { screenToWorldPoint, type CanvasViewport } from "./graphViewport";
import type {
  GraphSceneEdge,
  GraphSceneModel,
  GraphSceneNode,
} from "../graph-scene/graphSceneTypes";

interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GraphSceneVisibleItems {
  visibleNodeIds: Set<string>;
  visibleEdgeIds: Set<string>;
}

export interface GraphSceneRenderableRef<T extends { visible: boolean }> {
  id: string;
  group: T;
}

export interface GetVisibleGraphSceneItemsOptions {
  sceneModel: GraphSceneModel;
  viewport: CanvasViewport;
  hostWidth: number;
  hostHeight: number;
  padding?: number;
}

function intersectsRect(a: WorldRect, b: WorldRect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function nodeRect(node: GraphSceneNode): WorldRect {
  return {
    minX: node.x,
    minY: node.y,
    maxX: node.x + node.width,
    maxY: node.y + node.height,
  };
}

function edgeRect(edge: GraphSceneEdge, nodesById: ReadonlyMap<string, GraphSceneNode>): WorldRect | null {
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  if (!source || !target) return null;

  const sourcePoint = {
    x: source.x + source.width / 2,
    y: source.y + source.height,
  };
  const targetPoint = {
    x: target.x + target.width / 2,
    y: target.y,
  };
  const midY = (sourcePoint.y + targetPoint.y) / 2;

  return {
    minX: Math.min(sourcePoint.x, targetPoint.x),
    minY: Math.min(sourcePoint.y, targetPoint.y, midY),
    maxX: Math.max(sourcePoint.x, targetPoint.x),
    maxY: Math.max(sourcePoint.y, targetPoint.y, midY),
  };
}

function worldViewportRect(
  viewport: CanvasViewport,
  hostWidth: number,
  hostHeight: number,
  padding: number,
): WorldRect | null {
  if (hostWidth <= 0 || hostHeight <= 0 || viewport.zoom <= 0) return null;

  const topLeft = screenToWorldPoint(viewport, { x: 0, y: 0 });
  const bottomRight = screenToWorldPoint(viewport, { x: hostWidth, y: hostHeight });
  const paddingWorld = Math.max(0, padding) / viewport.zoom;

  return {
    minX: Math.min(topLeft.x, bottomRight.x) - paddingWorld,
    minY: Math.min(topLeft.y, bottomRight.y) - paddingWorld,
    maxX: Math.max(topLeft.x, bottomRight.x) + paddingWorld,
    maxY: Math.max(topLeft.y, bottomRight.y) + paddingWorld,
  };
}

export function getVisibleGraphSceneItems({
  sceneModel,
  viewport,
  hostWidth,
  hostHeight,
  padding = 160,
}: GetVisibleGraphSceneItemsOptions): GraphSceneVisibleItems {
  const visibleNodeIds = new Set<string>();
  const visibleEdgeIds = new Set<string>();
  const viewportRect = worldViewportRect(viewport, hostWidth, hostHeight, padding);
  if (!viewportRect) return { visibleNodeIds, visibleEdgeIds };

  for (const node of sceneModel.nodes) {
    if (intersectsRect(nodeRect(node), viewportRect)) {
      visibleNodeIds.add(node.id);
    }
  }

  const nodesById = new Map(sceneModel.nodes.map((node) => [node.id, node]));
  for (const edge of sceneModel.edges) {
    if (visibleNodeIds.has(edge.source) || visibleNodeIds.has(edge.target)) {
      visibleEdgeIds.add(edge.id);
      continue;
    }

    const bounds = edgeRect(edge, nodesById);
    if (bounds && intersectsRect(bounds, viewportRect)) {
      visibleEdgeIds.add(edge.id);
    }
  }

  return { visibleNodeIds, visibleEdgeIds };
}

export function applyGraphSceneRenderableVisibility<T extends { visible: boolean }>(
  renderables: readonly GraphSceneRenderableRef<T>[],
  visibleIds: ReadonlySet<string>,
): void {
  for (const renderable of renderables) {
    renderable.group.visible = visibleIds.has(renderable.id);
  }
}
