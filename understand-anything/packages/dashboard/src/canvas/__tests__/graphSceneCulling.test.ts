import { describe, expect, it } from "vitest";
import {
  applyGraphSceneRenderableVisibility,
  getVisibleGraphSceneItems,
} from "../graphSceneCulling";
import type {
  GraphSceneEdge,
  GraphSceneModel,
  GraphSceneNode,
} from "../../graph-scene/graphSceneTypes";

const state = {
  selected: false,
  highlighted: false,
  searchMatched: false,
  diffChanged: false,
  diffAffected: false,
  faded: false,
  focused: false,
};

const edgeState = {
  selected: false,
  faded: false,
  highlighted: false,
};

function node(id: string, x: number, y: number): GraphSceneNode {
  return {
    id,
    kind: "custom",
    x,
    y,
    width: 100,
    height: 80,
    data: {},
    state,
  };
}

function edge(id: string, source: string, target: string): GraphSceneEdge {
  return {
    id,
    source,
    target,
    style: {
      stroke: "#a39787",
      strokeWidth: 1,
    },
    state: edgeState,
  };
}

function model(
  nodes: readonly GraphSceneNode[],
  edges: readonly GraphSceneEdge[],
): GraphSceneModel {
  return {
    level: "layer-detail",
    nodes: [...nodes],
    edges: [...edges],
  };
}

describe("graph scene culling", () => {
  it("keeps nodes whose card rectangle intersects the padded world viewport", () => {
    const visible = getVisibleGraphSceneItems({
      sceneModel: model(
        [
          node("inside", 40, 40),
          node("near-padding", 330, 40),
          node("outside", 520, 40),
        ],
        [],
      ),
      viewport: { x: 0, y: 0, zoom: 1 },
      hostWidth: 300,
      hostHeight: 200,
      padding: 50,
    });

    expect([...visible.visibleNodeIds].sort()).toEqual(["inside", "near-padding"]);
  });

  it("translates the screen viewport back into world coordinates", () => {
    const visible = getVisibleGraphSceneItems({
      sceneModel: model([node("left", 20, 20), node("panned", 500, 20)], []),
      viewport: { x: -400, y: 0, zoom: 1 },
      hostWidth: 300,
      hostHeight: 200,
      padding: 0,
    });

    expect([...visible.visibleNodeIds]).toEqual(["panned"]);
  });

  it("keeps an edge when either endpoint is visible", () => {
    const scene = model(
      [node("a", 40, 40), node("b", 900, 40)],
      [edge("a-to-b", "a", "b")],
    );

    const visible = getVisibleGraphSceneItems({
      sceneModel: scene,
      viewport: { x: 0, y: 0, zoom: 1 },
      hostWidth: 300,
      hostHeight: 200,
      padding: 0,
    });

    expect(visible.visibleEdgeIds.has("a-to-b")).toBe(true);
  });

  it("keeps an edge whose span crosses the visible viewport even when endpoints are off-screen", () => {
    const scene = model(
      [node("left", -250, 40), node("right", 450, 40), node("far", 900, 40)],
      [edge("crosses", "left", "right"), edge("far-away", "right", "far")],
    );

    const visible = getVisibleGraphSceneItems({
      sceneModel: scene,
      viewport: { x: 0, y: 0, zoom: 1 },
      hostWidth: 300,
      hostHeight: 200,
      padding: 0,
    });

    expect([...visible.visibleEdgeIds]).toEqual(["crosses"]);
  });

  it("applies visibility sets to retained canvas renderable groups", () => {
    const renderables = [
      { id: "visible", group: { visible: false } },
      { id: "hidden", group: { visible: true } },
    ];

    applyGraphSceneRenderableVisibility(renderables, new Set(["visible"]));

    expect(renderables).toEqual([
      { id: "visible", group: { visible: true } },
      { id: "hidden", group: { visible: false } },
    ]);
  });
});
