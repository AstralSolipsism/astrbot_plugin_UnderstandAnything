import { describe, expect, it } from "vitest";
import { getGraphSceneNodeAction } from "../graphSceneActions";
import type { GraphSceneNode } from "../graphSceneTypes";

function sceneNode(
  overrides: Partial<GraphSceneNode> & Pick<GraphSceneNode, "id" | "kind">,
): GraphSceneNode {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 80,
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
    ...overrides,
  };
}

describe("graph scene node actions", () => {
  it("drills into an overview layer cluster by layer id", () => {
    expect(
      getGraphSceneNodeAction("overview", sceneNode({
        id: "visual-id",
        kind: "layer-cluster",
        data: { layerId: "layer:api" },
      })),
    ).toEqual({ type: "drill-layer", layerId: "layer:api" });
  });

  it("selects custom nodes in layer detail", () => {
    expect(
      getGraphSceneNodeAction("layer-detail", sceneNode({
        id: "file:a",
        kind: "custom",
      })),
    ).toEqual({ type: "select-node", nodeId: "file:a" });
  });

  it("toggles containers in layer detail", () => {
    expect(
      getGraphSceneNodeAction("layer-detail", sceneNode({
        id: "container:src",
        kind: "container",
        data: { containerId: "container:src" },
      })),
    ).toEqual({ type: "toggle-container", containerId: "container:src" });
  });

  it("drills through portals in layer detail", () => {
    expect(
      getGraphSceneNodeAction("layer-detail", sceneNode({
        id: "portal:layer:db",
        kind: "portal",
        data: { targetLayerId: "layer:db" },
      })),
    ).toEqual({ type: "drill-layer", layerId: "layer:db" });
  });
});
