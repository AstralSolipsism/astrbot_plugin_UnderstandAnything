import type { CanvasGraphNode } from "./graphTypes";

export interface GraphContextMenuState {
  node: CanvasGraphNode;
  x: number;
  y: number;
}

export function placeGraphContextMenu(
  node: CanvasGraphNode,
  clientX: number,
  clientY: number,
  hostRect: DOMRect,
): GraphContextMenuState {
  return {
    node,
    x: clientX - hostRect.left,
    y: clientY - hostRect.top,
  };
}
