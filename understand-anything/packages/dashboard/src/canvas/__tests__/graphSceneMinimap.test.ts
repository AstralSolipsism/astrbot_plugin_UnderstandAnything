import { describe, expect, it } from "vitest";
import {
  buildGraphSceneMiniMap,
  miniMapPointToScenePoint,
  projectViewportToMiniMap,
} from "../graphSceneMinimap";
import type { GraphSceneModel } from "../../graph-scene/graphSceneTypes";

const scene: GraphSceneModel = {
  level: "overview",
  nodes: [
    {
      id: "a",
      kind: "layer-cluster",
      x: 100,
      y: 50,
      width: 320,
      height: 180,
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
    },
    {
      id: "b",
      kind: "custom",
      x: 520,
      y: 250,
      width: 280,
      height: 120,
      data: {},
      state: {
        selected: true,
        highlighted: false,
        searchMatched: false,
        diffChanged: false,
        diffAffected: false,
        faded: false,
        focused: false,
      },
    },
  ],
  edges: [],
};

describe("graph scene minimap", () => {
  it("projects scene node rectangles into minimap coordinates", () => {
    const minimap = buildGraphSceneMiniMap(scene, 160, 100, 8);

    expect(minimap.items).toHaveLength(2);
    expect(minimap.items[0]).toMatchObject({
      id: "a",
      kind: "layer-cluster",
      x: 8,
      y: 8,
    });
    expect(minimap.items[1]).toMatchObject({
      id: "b",
      kind: "custom",
      selected: true,
    });
    expect(minimap.viewBox).toEqual("0 0 160 100");
  });

  it("projects the active canvas viewport into a minimap viewport rectangle", () => {
    const minimap = buildGraphSceneMiniMap(scene, 160, 100, 8);
    const viewportRect = projectViewportToMiniMap(
      minimap,
      { x: -100, y: -50, zoom: 1 },
      320,
      180,
    );

    expect(viewportRect.x).toBe(8);
    expect(viewportRect.y).toBe(8);
    expect(viewportRect.width).toBeCloseTo(65.82857, 5);
    expect(viewportRect.height).toBeCloseTo(37.02857, 5);
  });

  it("maps a minimap pointer position back to the scene center point", () => {
    const minimap = buildGraphSceneMiniMap(scene, 160, 100, 8);

    expect(miniMapPointToScenePoint(minimap, { x: 8, y: 8 })).toEqual({
      x: 100,
      y: 50,
    });
    const center = miniMapPointToScenePoint(minimap, { x: 88, y: 53 });
    expect(center.x).toBeCloseTo(488.88889, 5);
    expect(center.y).toBeCloseTo(268.75, 5);
  });
});
