import { describe, expect, it } from "vitest";
import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import {
  repairAndAssessGraphQuality,
  validateChineseVisibleContent,
  type SourceInventory,
  type SourceInventoryCategory,
  type SourceInventoryEntry,
} from "../quality.js";

function node(overrides: Partial<GraphNode> & Pick<GraphNode, "id" | "type" | "name">): GraphNode {
  return {
    summary: `${overrides.name} 摘要`,
    tags: ["测试"],
    complexity: "simple",
    ...overrides,
  };
}

function graph(nodes: GraphNode[], edges: KnowledgeGraph["edges"] = []): KnowledgeGraph {
  return {
    version: "1.0.0",
    kind: "knowledge",
    project: {
      name: "质量测试",
      languages: ["typescript"],
      frameworks: [],
      description: "这是用于质量校验的中文项目说明。",
      analyzedAt: new Date(0).toISOString(),
      gitCommitHash: "quality-test",
    },
    nodes,
    edges,
    layers: [
      {
        id: "layer:code",
        name: "代码层",
        description: "代码层说明",
        nodeIds: nodes.map((item) => item.id),
      },
    ],
    tour: [
      {
        order: 1,
        title: "中文导览",
        description: "导览说明",
        nodeIds: nodes.slice(0, 1).map((item) => item.id),
      },
    ],
  };
}

function entry(
  path: string,
  kind: SourceInventoryEntry["kind"],
  category: SourceInventoryCategory = "code",
): SourceInventoryEntry {
  return {
    path,
    kind,
    language: kind === "directory" ? "directory" : "typescript",
    sizeBytes: kind === "directory" ? 0 : 100,
    lineCount: kind === "directory" ? 0 : 20,
    hash: `hash:${path}`,
    category,
  };
}

function inventory(entries: SourceInventoryEntry[]): SourceInventory {
  return {
    version: "1.0.0",
    generatedAt: new Date(0).toISOString(),
    gitCommitHash: "quality-test",
    entries,
    totals: {
      files: entries.filter((item) => item.kind === "file").length,
      directories: entries.filter((item) => item.kind === "directory").length,
      bytes: entries.reduce((sum, item) => sum + item.sizeBytes, 0),
    },
  };
}

describe("runtime graph quality gates", () => {
  it("removes knowledge graph nodes that reference files outside the source inventory", () => {
    const sourceInventory = inventory([
      entry("src", "directory"),
      entry("src/real.ts", "file"),
    ]);
    const result = repairAndAssessGraphQuality(
      graph(
        [
          node({ id: "file:src/real.ts", type: "file", name: "real.ts", filePath: "src/real.ts" }),
          node({ id: "function:real", type: "function", name: "real", filePath: "src/real.ts", lineRange: [1, 5] }),
          node({ id: "file:src/missing.ts", type: "file", name: "missing.ts", filePath: "src/missing.ts" }),
          node({ id: "function:escape", type: "function", name: "escape", filePath: "../escape.ts" }),
        ],
        [
          { source: "file:src/real.ts", target: "function:real", type: "contains", direction: "forward", weight: 1 },
          { source: "file:src/missing.ts", target: "function:escape", type: "contains", direction: "forward", weight: 1 },
        ],
      ),
      "knowledge",
      sourceInventory,
    );

    expect(result.graph.nodes.map((item) => item.id)).toEqual(["file:src/real.ts", "function:real"]);
    expect(result.graph.edges).toHaveLength(1);
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      "missing-file-node-removed",
      "invalid-filepath-node-removed",
    ]));
  });

  it("reports duplicate node ids as fatal quality issues", () => {
    const result = repairAndAssessGraphQuality(
      graph([
        node({ id: "file:src/a.ts", type: "file", name: "a.ts", filePath: "src/a.ts" }),
        node({ id: "file:src/a.ts", type: "file", name: "duplicate.ts", filePath: "src/a.ts" }),
      ]),
      "knowledge",
      inventory([entry("src/a.ts", "file")]),
    );

    expect(result.issues).toContainEqual(expect.objectContaining({
      level: "fatal",
      code: "duplicate-node-id",
      nodeId: "file:src/a.ts",
    }));
  });

  it("reports placeholder text as a blocking quality error", () => {
    const result = repairAndAssessGraphQuality(
      graph([
        node({
          id: "file:src/a.ts",
          type: "file",
          name: "a.ts",
          filePath: "src/a.ts",
          summary: "文件不存在，可能已被重命名。",
        }),
      ]),
      "knowledge",
      inventory([entry("src/a.ts", "file")]),
    );

    expect(result.issues).toContainEqual(expect.objectContaining({
      level: "warning",
      code: "placeholder-node-removed",
      nodeId: "file:src/a.ts",
    }));
  });

  it("rejects mostly non-Chinese visible content when Chinese output is required", () => {
    const englishGraph = graph([
      node({
        id: "file:src/a.ts",
        type: "file",
        name: "a.ts",
        filePath: "src/a.ts",
        summary: "This file handles the order workflow.",
      }),
    ]);
    englishGraph.project.description = "This project is described in English.";
    englishGraph.layers[0].description = "Application layer";
    englishGraph.tour[0].description = "Tour description";

    expect(() => validateChineseVisibleContent("knowledge-graph.json", englishGraph)).toThrow(
      /Chinese|中文/,
    );
  });
});
