import type { CanvasGraphNode, CanvasPoint } from "./graphTypes";
import type { GraphSceneNode } from "../graph-scene/graphSceneTypes";

export interface GraphHitIndex {
  cellSize: number;
  cells: Map<string, CanvasGraphNode[]>;
}

export interface GraphSceneHitIndex {
  cellSize: number;
  cells: Map<string, GraphSceneNode[]>;
}

const DEFAULT_CELL_SIZE = 100;

function normalizeCellSize(cellSize: number): number {
  return Number.isFinite(cellSize) && cellSize > 0 ? cellSize : DEFAULT_CELL_SIZE;
}

function cellCoordinate(value: number, cellSize: number): number {
  return Math.floor(value / cellSize);
}

function cellKey(cellX: number, cellY: number): string {
  return `${cellX}:${cellY}`;
}

export function buildGraphHitIndex(
  nodes: CanvasGraphNode[],
  requestedCellSize = DEFAULT_CELL_SIZE,
): GraphHitIndex {
  const cellSize = normalizeCellSize(requestedCellSize);
  const cells = new Map<string, CanvasGraphNode[]>();

  for (const node of nodes) {
    const key = cellKey(cellCoordinate(node.x, cellSize), cellCoordinate(node.y, cellSize));
    const bucket = cells.get(key);
    if (bucket) {
      bucket.push(node);
    } else {
      cells.set(key, [node]);
    }
  }

  return { cellSize, cells };
}

export function findNearestGraphNode(
  index: GraphHitIndex,
  point: CanvasPoint,
  radius: number,
): CanvasGraphNode | null {
  const searchRadius = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const originCellX = cellCoordinate(point.x, index.cellSize);
  const originCellY = cellCoordinate(point.y, index.cellSize);
  let nearest: CanvasGraphNode | null = null;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;

  for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const bucket = index.cells.get(cellKey(originCellX + offsetX, originCellY + offsetY));
      if (!bucket) continue;

      for (const node of bucket) {
        const dx = node.x - point.x;
        const dy = node.y - point.y;
        const distanceSquared = dx * dx + dy * dy;
        const allowedRadius = searchRadius + node.radius;
        if (distanceSquared > allowedRadius * allowedRadius) continue;
        if (distanceSquared >= nearestDistanceSquared) continue;
        nearest = node;
        nearestDistanceSquared = distanceSquared;
      }
    }
  }

  return nearest;
}

export function buildGraphSceneHitIndex(
  nodes: GraphSceneNode[],
  requestedCellSize = DEFAULT_CELL_SIZE,
): GraphSceneHitIndex {
  const cellSize = normalizeCellSize(requestedCellSize);
  const cells = new Map<string, GraphSceneNode[]>();

  for (const node of nodes) {
    const minCellX = cellCoordinate(node.x, cellSize);
    const minCellY = cellCoordinate(node.y, cellSize);
    const maxCellX = cellCoordinate(node.x + node.width, cellSize);
    const maxCellY = cellCoordinate(node.y + node.height, cellSize);

    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        const key = cellKey(cellX, cellY);
        const bucket = cells.get(key);
        if (bucket) {
          bucket.push(node);
        } else {
          cells.set(key, [node]);
        }
      }
    }
  }

  return { cellSize, cells };
}

function containsSceneNodePoint(node: GraphSceneNode, point: CanvasPoint): boolean {
  return (
    point.x >= node.x &&
    point.x <= node.x + node.width &&
    point.y >= node.y &&
    point.y <= node.y + node.height
  );
}

export function findGraphSceneNodeAt(
  index: GraphSceneHitIndex,
  point: CanvasPoint,
): GraphSceneNode | null {
  const bucket = index.cells.get(
    cellKey(cellCoordinate(point.x, index.cellSize), cellCoordinate(point.y, index.cellSize)),
  );
  if (!bucket) return null;

  for (let i = bucket.length - 1; i >= 0; i -= 1) {
    const node = bucket[i];
    if (containsSceneNodePoint(node, point)) return node;
  }

  return null;
}
