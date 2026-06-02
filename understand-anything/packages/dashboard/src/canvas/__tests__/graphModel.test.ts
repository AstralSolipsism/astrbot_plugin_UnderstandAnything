import { describe, expect, it } from "vitest";
import type {
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
  Layer,
} from "@understand-anything/core/types";
import { buildCanvasGraphModel } from "../graphModel";

function node(id: string, type: GraphNode["type"] = "file"): GraphNode {
  return {
    id,
    type,
    name: id,
    summary: `${id} summary`,
    tags: [],
    complexity: "simple",
  };
}

function edge(source: string, target: string): GraphEdge {
  return {
    source,
    target,
    type: "imports",
    direction: "forward",
    weight: 1,
  };
}

function layer(id: string, nodeIds: string[]): Layer {
  return {
    id,
    name: id,
    description: `${id} description`,
    nodeIds,
  };
}

function graph(overrides: Partial<KnowledgeGraph> = {}): KnowledgeGraph {
  return {
    version: "1.0.0",
    project: {
      name: "sample",
      languages: [],
      frameworks: [],
      description: "",
      analyzedAt: "2026-06-01T00:00:00.000Z",
      gitCommitHash: "abc",
    },
    nodes: [node("a"), node("b"), node("c", "config")],
    edges: [edge("a", "b"), edge("a", "missing")],
    layers: [layer("layer-1", ["a", "b"]), layer("layer-2", ["c"])],
    tour: [],
    ...overrides,
  };
}

describe("buildCanvasGraphModel", () => {
  it("places every graph node exactly once", () => {
    const model = buildCanvasGraphModel(graph());

    expect(model.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("drops edges whose endpoints are absent from the node model", () => {
    const model = buildCanvasGraphModel(graph());

    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("groups coordinates by first matching layer", () => {
    const model = buildCanvasGraphModel(graph());
    const byId = new Map(model.nodes.map((n) => [n.id, n]));

    expect(byId.get("a")?.layerId).toBe("layer-1");
    expect(byId.get("b")?.layerId).toBe("layer-1");
    expect(byId.get("c")?.layerId).toBe("layer-2");
    expect(Math.abs((byId.get("c")?.x ?? 0) - (byId.get("a")?.x ?? 0))).toBeGreaterThan(300);
  });

  it("assigns unlayered nodes to a stable fallback bucket", () => {
    const model = buildCanvasGraphModel(
      graph({
        layers: [layer("layer-1", ["a"])],
      }),
    );
    const b = model.nodes.find((n) => n.id === "b");

    expect(b?.layerId).toBeNull();
    expect(b?.layerIndex).toBe(1);
  });
});
