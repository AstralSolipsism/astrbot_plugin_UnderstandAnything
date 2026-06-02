import { describe, expect, it } from "vitest";
import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import {
  buildGraphSceneModelFromFlow,
  buildOverviewSceneModel,
} from "../buildGraphScene";
import {
  LAYER_CLUSTER_HEIGHT,
  LAYER_CLUSTER_WIDTH,
} from "../../utils/layout";

function node(id: string, complexity: GraphNode["complexity"] = "simple"): GraphNode {
  return {
    id,
    type: "file",
    name: id,
    filePath: `${id}.ts`,
    summary: `${id} summary`,
    tags: [],
    complexity,
  };
}

function graphFixture(): KnowledgeGraph {
  const nodes = [node("api:a", "complex"), node("api:b"), node("core:c", "moderate")];
  return {
    version: "1.0.0",
    project: {
      name: "Fixture",
      languages: ["TypeScript"],
      frameworks: [],
      description: "fixture",
      analyzedAt: "2026-06-01T00:00:00.000Z",
      gitCommitHash: "test",
    },
    nodes,
    edges: [
      {
        source: "api:a",
        target: "core:c",
        type: "imports",
        direction: "forward",
        weight: 1,
      },
      {
        source: "core:c",
        target: "api:b",
        type: "calls",
        direction: "forward",
        weight: 1,
      },
    ],
    layers: [
      {
        id: "layer:api",
        name: "API Layer",
        description: "HTTP entrypoints",
        nodeIds: ["api:a", "api:b"],
      },
      {
        id: "layer:core",
        name: "Core Layer",
        description: "Domain logic",
        nodeIds: ["core:c"],
      },
    ],
    tour: [],
  };
}

describe("overview graph scene parity", () => {
  it("builds baseline layer-cluster cards instead of full-node scatter points", () => {
    const graph = graphFixture();
    const scene = buildOverviewSceneModel({
      graph,
      searchResultNodeIds: new Set(["api:a"]),
    });

    expect(scene.level).toBe("overview");
    expect(scene.nodes).toHaveLength(2);
    expect(scene.nodes.map((candidate) => candidate.id)).toEqual([
      "layer:api",
      "layer:core",
    ]);
    expect(scene.nodes.every((candidate) => candidate.kind === "layer-cluster")).toBe(true);
    expect(scene.nodes.some((candidate) => candidate.id === "api:a")).toBe(false);

    const apiLayer = scene.nodes[0];
    expect(apiLayer.width).toBe(LAYER_CLUSTER_WIDTH);
    expect(apiLayer.height).toBe(LAYER_CLUSTER_HEIGHT);
    expect(apiLayer.data).toMatchObject({
      layerId: "layer:api",
      layerName: "API Layer",
      layerDescription: "HTTP entrypoints",
      fileCount: 2,
      layerColorIndex: 0,
      searchMatchCount: 1,
      aggregateComplexity: "complex",
    });
  });

  it("preserves baseline aggregated layer edge labels and styling", () => {
    const scene = buildOverviewSceneModel({ graph: graphFixture() });

    expect(scene.edges).toHaveLength(1);
    expect(scene.edges[0]).toMatchObject({
      id: "le-0",
      source: "layer:api",
      target: "layer:core",
      label: "2",
      state: {
        selected: false,
        faded: false,
      },
    });
    expect(scene.edges[0].style.stroke).toBe("rgba(212,165,116,0.4)");
    expect(scene.edges[0].labelStyle).toMatchObject({
      fill: "#a39787",
      fontSize: 11,
      fontWeight: 600,
    });
  });

  it("preserves layer-detail custom, container, portal nodes from flow topology", () => {
    const scene = buildGraphSceneModelFromFlow({
      level: "layer-detail",
      nodes: [
        {
          id: "file:a",
          type: "custom",
          position: { x: 10, y: 20 },
          data: {
            label: "File A",
            isSelected: true,
            isHighlighted: true,
            isTourHighlighted: false,
            isDiffChanged: true,
            isDiffAffected: false,
            isDiffFaded: false,
            isSelectionFaded: false,
          },
        },
        {
          id: "container:src",
          type: "container",
          position: { x: 300, y: 40 },
          width: 640,
          height: 360,
          data: {
            hasSearchHits: true,
            searchHitCount: 2,
            isDiffAffected: true,
            isFocusedViaChild: true,
          },
        },
        {
          id: "portal:layer:db",
          type: "portal",
          position: { x: 1000, y: 120 },
          data: {
            targetLayerId: "layer:db",
          },
        },
      ],
      edges: [
        {
          id: "edge:1",
          source: "container:src",
          target: "portal:layer:db",
          label: "imports",
          style: {
            stroke: "rgba(212,165,116,0.5)",
            strokeWidth: 1.5,
            strokeDasharray: "5 5",
          },
          labelStyle: {
            fill: "#a39787",
            fontSize: 10,
            fontWeight: 600,
          },
        },
      ],
    });

    expect(scene.level).toBe("layer-detail");
    expect(scene.nodes.map((node) => [node.id, node.kind])).toEqual([
      ["file:a", "custom"],
      ["container:src", "container"],
      ["portal:layer:db", "portal"],
    ]);
    expect(scene.nodes[0]).toMatchObject({
      x: 10,
      y: 20,
      width: 280,
      height: 120,
      state: {
        selected: true,
        highlighted: true,
        searchMatched: false,
        diffChanged: true,
        diffAffected: false,
        faded: false,
      },
    });
    expect(scene.nodes[1]).toMatchObject({
      width: 640,
      height: 360,
      state: {
        searchMatched: true,
        diffAffected: true,
        focused: true,
      },
    });
    expect(scene.nodes[2]).toMatchObject({
      width: 240,
      height: 80,
    });
    expect(scene.edges[0]).toMatchObject({
      id: "edge:1",
      source: "container:src",
      target: "portal:layer:db",
      label: "imports",
      style: {
        stroke: "rgba(212,165,116,0.5)",
        strokeWidth: 1.5,
        strokeDasharray: "5 5",
      },
      labelStyle: {
        fill: "#a39787",
        fontSize: 10,
        fontWeight: 600,
      },
    });
  });

  it("converts expanded child nodes from parent-relative to scene-absolute positions", () => {
    const scene = buildGraphSceneModelFromFlow({
      level: "layer-detail",
      nodes: [
        {
          id: "container:src",
          type: "container",
          position: { x: 300, y: 40 },
          width: 640,
          height: 360,
          data: {},
        },
        {
          id: "file:a",
          type: "custom",
          parentId: "container:src",
          position: { x: 24, y: 36 },
          data: {
            label: "File A",
          },
        },
      ],
      edges: [],
    });

    expect(scene.nodes.find((node) => node.id === "file:a")).toMatchObject({
      x: 324,
      y: 76,
    });
  });
});
