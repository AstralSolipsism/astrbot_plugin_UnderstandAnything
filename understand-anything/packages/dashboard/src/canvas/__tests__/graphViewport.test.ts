import { describe, expect, it } from "vitest";
import {
  centerCanvasViewportOn,
  fitCanvasBounds,
  fitCanvasSceneNodes,
  screenToWorldPoint,
  zoomCanvasViewportAt,
} from "../graphViewport";
import type { CanvasBounds } from "../graphTypes";
import type { GraphSceneNode } from "../../graph-scene/graphSceneTypes";

const bounds: CanvasBounds = {
  minX: 0,
  minY: 0,
  maxX: 1000,
  maxY: 500,
  width: 1000,
  height: 500,
};

function sceneNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): GraphSceneNode {
  return {
    id,
    kind: "layer-cluster",
    x,
    y,
    width,
    height,
    data: {},
    state: {
      selected: false,
      highlighted: false,
      searchMatched: false,
      diffChanged: false,
      diffAffected: false,
      faded: false,
      focused: false,
    },
  };
}

describe("graph viewport helpers", () => {
  it("fits graph bounds into the host with padding", () => {
    expect(fitCanvasBounds(bounds, 500, 300, 50)).toEqual({
      x: 50,
      y: 50,
      zoom: 0.4,
    });
  });

  it("keeps the world point under the cursor stable when zooming", () => {
    const before = { x: 20, y: 40, zoom: 0.5 };
    const cursor = { x: 220, y: 140 };
    const worldBefore = screenToWorldPoint(before, cursor);
    const after = zoomCanvasViewportAt(before, cursor, 2, 0.05, 4);
    const worldAfter = screenToWorldPoint(after, cursor);

    expect(after.zoom).toBe(1);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 5);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 5);
  });

  it("clamps requested zoom", () => {
    expect(zoomCanvasViewportAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 100, 0.05, 4).zoom).toBe(4);
  });

  it("fits scene node rectangles into the host", () => {
    const viewport = fitCanvasSceneNodes(
      [
        sceneNode("a", 100, 50, 200, 100),
        sceneNode("b", 400, 250, 100, 100),
      ],
      500,
      300,
      50,
    );

    expect(viewport.x).toBeCloseTo(50, 5);
    expect(viewport.y).toBeCloseTo(16.66667, 5);
    expect(viewport.zoom).toBeCloseTo(0.66667, 5);
  });

  it("sets the viewport center without changing the requested zoom", () => {
    expect(centerCanvasViewportOn({ x: 100, y: 50 }, 800, 600, 1.5)).toEqual({
      x: 250,
      y: 225,
      zoom: 1.5,
    });
  });
});
