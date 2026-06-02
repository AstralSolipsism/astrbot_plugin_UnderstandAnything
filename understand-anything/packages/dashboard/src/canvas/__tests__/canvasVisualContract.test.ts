import { describe, expect, it } from "vitest";
import { buildContainerNodePaintSpec } from "../renderContainerNode";
import { buildCustomNodePaintSpec } from "../renderCustomNode";
import {
  buildEdgeLabelTextPaintOptions,
  GRAPH_RENDER_LAYER_ORDER,
} from "../graphRendererSceneLayers";
import { buildLayerClusterPaintSpec } from "../renderLayerCluster";
import { buildPortalNodePaintSpec } from "../renderPortalNode";
import type { GraphSceneNode } from "../../graph-scene/graphSceneTypes";
import {
  LAYER_CLUSTER_HEIGHT,
  LAYER_CLUSTER_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  PORTAL_NODE_HEIGHT,
  PORTAL_NODE_WIDTH,
} from "../../utils/layout";

function layerClusterNode(): GraphSceneNode {
  return {
    id: "layer:api",
    kind: "layer-cluster",
    x: 40,
    y: 80,
    width: LAYER_CLUSTER_WIDTH,
    height: LAYER_CLUSTER_HEIGHT,
    data: {
      layerName: "API Layer",
      layerDescription: "HTTP entrypoints",
      fileCount: 2,
      aggregateComplexity: "complex",
      layerColorIndex: 0,
      searchMatchCount: 3,
    },
    state: {
      selected: false,
      highlighted: false,
      searchMatched: true,
      diffChanged: false,
      diffAffected: false,
      faded: false,
      focused: false,
    },
  };
}

describe("canvas visual contract", () => {
  it("builds the baseline layer-cluster card paint spec", () => {
    const spec = buildLayerClusterPaintSpec(layerClusterNode());

    expect(spec.card).toMatchObject({
      x: 40,
      y: 80,
      width: LAYER_CLUSTER_WIDTH,
      height: LAYER_CLUSTER_HEIGHT,
      cornerRadius: 12,
    });
    expect(spec.strip).toMatchObject({
      x: 40,
      y: 80,
      width: 6,
      height: LAYER_CLUSTER_HEIGHT,
      fill: "#4a7c9b",
    });
    expect(spec.texts.map((text) => text.text)).toEqual([
      "层级",
      "复杂",
      "命中 3",
      "API Layer",
      "HTTP entrypoints",
      "2 个文件",
      "点击查看 →",
    ]);
  });

  it("builds the baseline custom node card paint spec", () => {
    const spec = buildCustomNodePaintSpec({
      id: "file:a",
      kind: "custom",
      x: 10,
      y: 20,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        label: "File A",
        nodeType: "file",
        summary: "Entry file summary",
        complexity: "complex",
        tags: ["tested"],
      },
      state: {
        selected: true,
        highlighted: false,
        searchMatched: false,
        diffChanged: false,
        diffAffected: false,
        faded: false,
        focused: false,
      },
    });

    expect(spec.card).toMatchObject({
      x: 10,
      y: 20,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      cornerRadius: 8,
    });
    expect(spec.strip.fill).toBe("var(--color-node-file)");
    expect(spec.testedMarker).toMatchObject({ width: 6, height: 6 });
    expect(spec.texts.map((text) => text.text)).toEqual([
      "文件",
      "复杂",
      "File A",
      "Entry file summary",
    ]);
  });

  it("builds the baseline container and portal paint specs", () => {
    const container = buildContainerNodePaintSpec({
      id: "container:src",
      kind: "container",
      x: 50,
      y: 60,
      width: 640,
      height: 360,
      data: {
        name: "src",
        childCount: 4,
        colorIndex: 1,
        isExpanded: true,
        searchHitCount: 2,
        isDiffAffected: false,
        isFocusedViaChild: false,
      },
      state: {
        selected: false,
        highlighted: false,
        searchMatched: true,
        diffChanged: false,
        diffAffected: false,
        faded: false,
        focused: false,
      },
    });
    const portal = buildPortalNodePaintSpec({
      id: "portal:layer:db",
      kind: "portal",
      x: 700,
      y: 80,
      width: PORTAL_NODE_WIDTH,
      height: PORTAL_NODE_HEIGHT,
      data: {
        targetLayerName: "Data Layer",
        connectionCount: 7,
        layerColorIndex: 2,
      },
      state: {
        selected: false,
        highlighted: false,
        searchMatched: false,
        diffChanged: false,
        diffAffected: false,
        faded: false,
        focused: false,
      },
    });

    expect(container.card).toMatchObject({
      width: 640,
      height: 360,
      cornerRadius: 12,
    });
    expect(container.texts.map((text) => text.text)).toEqual(["▾ src", "命中 2", "4"]);

    expect(portal.card).toMatchObject({
      width: PORTAL_NODE_WIDTH,
      height: PORTAL_NODE_HEIGHT,
      cornerRadius: 8,
    });
    expect(portal.texts.map((text) => text.text)).toEqual([
      "Data Layer",
      "→",
      "7 个连接",
    ]);
  });

  it("keeps edge labels below cards and without an opaque backing stroke", () => {
    expect(GRAPH_RENDER_LAYER_ORDER.indexOf("label")).toBeLessThan(
      GRAPH_RENDER_LAYER_ORDER.indexOf("node"),
    );

    const label = buildEdgeLabelTextPaintOptions({
      x: 120,
      y: 80,
      text: "imports",
      fill: "#a39787",
      fontSize: 10,
      fontWeight: 600,
    });

    expect(label).toMatchObject({
      x: 120,
      y: 80,
      text: "imports",
      fill: "#a39787",
      fontSize: 10,
      fontWeight: 600,
      hittable: false,
    });
    expect(label).not.toHaveProperty("stroke");
    expect(label).not.toHaveProperty("strokeWidth");
  });
});
