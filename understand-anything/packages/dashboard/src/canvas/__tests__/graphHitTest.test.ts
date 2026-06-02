import { describe, expect, it } from "vitest";
import {
  buildGraphHitIndex,
  buildGraphSceneHitIndex,
  findNearestGraphNode,
  findGraphSceneNodeAt,
} from "../graphHitTest";
import type { CanvasGraphNode } from "../graphTypes";
import type { GraphSceneNode } from "../../graph-scene/graphSceneTypes";

function canvasNode(id: string, x: number, y: number): CanvasGraphNode {
  return {
    id,
    label: id,
    nodeType: "file",
    layerId: null,
    layerIndex: 0,
    x,
    y,
    radius: 6,
    color: "#ffffff",
  };
}

function sceneNode(
  id: string,
  x: number,
  y: number,
  width = 320,
  height = 180,
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

describe("graph hit testing", () => {
  it("finds the nearest node inside the search radius", () => {
    const index = buildGraphHitIndex(
      [canvasNode("a", 100, 100), canvasNode("b", 240, 240)],
      100,
    );

    expect(findNearestGraphNode(index, { x: 102, y: 98 }, 10)?.id).toBe("a");
  });

  it("returns null when no node is inside the search radius", () => {
    const index = buildGraphHitIndex([canvasNode("a", 100, 100)], 100);

    expect(findNearestGraphNode(index, { x: 300, y: 300 }, 10)).toBeNull();
  });

  it("chooses the closest candidate across neighboring cells", () => {
    const index = buildGraphHitIndex(
      [canvasNode("far", 198, 100), canvasNode("near", 202, 100)],
      100,
    );

    expect(findNearestGraphNode(index, { x: 205, y: 100 }, 20)?.id).toBe("near");
  });

  it("finds scene nodes by their full card rectangle across indexed cells", () => {
    const index = buildGraphSceneHitIndex([sceneNode("layer:api", 90, 90, 80, 60)], 100);

    expect(findGraphSceneNodeAt(index, { x: 150, y: 120 })?.id).toBe("layer:api");
  });

  it("returns the topmost scene node when card rectangles overlap", () => {
    const index = buildGraphSceneHitIndex(
      [
        sceneNode("under", 0, 0, 100, 100),
        sceneNode("over", 20, 20, 100, 100),
      ],
      100,
    );

    expect(findGraphSceneNodeAt(index, { x: 40, y: 40 })?.id).toBe("over");
  });
});
