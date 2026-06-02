import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import { describe, expect, it } from "vitest";
import {
  buildAssistantReferenceIndex,
  findAssistantReferenceMatches,
} from "../assistantReferenceIndex";

function node(overrides: Partial<GraphNode> & Pick<GraphNode, "id" | "type" | "name">): GraphNode {
  return {
    summary: `${overrides.name} summary`,
    tags: [],
    complexity: "simple",
    ...overrides,
  };
}

function graph(nodes: GraphNode[], edges: KnowledgeGraph["edges"] = []): KnowledgeGraph {
  return {
    version: "1.0.0",
    kind: "knowledge",
    project: {
      name: "fixture",
      languages: ["typescript"],
      frameworks: [],
      description: "fixture graph",
      analyzedAt: new Date(0).toISOString(),
      gitCommitHash: "fixture",
    },
    nodes,
    edges,
    layers: [],
    tour: [],
  };
}

describe("assistant markdown reference index", () => {
  it("links known file paths and code ranges", () => {
    const index = buildAssistantReferenceIndex(
      graph([
        node({
          id: "src/main.ts",
          type: "file",
          name: "main.ts",
          filePath: "src/main.ts",
        }),
      ]),
      null,
    );

    expect(findAssistantReferenceMatches("See src/main.ts and src/main.ts:12-24.", index)).toEqual([
      {
        start: 4,
        end: 15,
        text: "src/main.ts",
        href: "file:src%2Fmain.ts",
      },
      {
        start: 20,
        end: 37,
        text: "src/main.ts:12-24",
        href: "code-range:src%2Fmain.ts:12-24",
      },
    ]);
  });

  it("links node ids and unique node names without linking ambiguous names", () => {
    const index = buildAssistantReferenceIndex(
      graph([
        node({ id: "service:auth", type: "service", name: "AuthService" }),
        node({ id: "service:billing", type: "service", name: "Duplicate" }),
        node({ id: "service:orders", type: "service", name: "Duplicate" }),
      ]),
      null,
    );

    expect(findAssistantReferenceMatches("AuthService calls service:auth, Duplicate is ambiguous.", index)).toEqual([
      {
        start: 0,
        end: 11,
        text: "AuthService",
        href: "node:service%3Aauth",
      },
      {
        start: 18,
        end: 30,
        text: "service:auth",
        href: "node:service%3Aauth",
      },
    ]);
  });

  it("links domain, flow, and step names from the domain graph", () => {
    const domain = graph([
      node({ id: "domain:billing", type: "domain", name: "支付域" }),
      node({ id: "flow:checkout", type: "flow", name: "结算流程" }),
      node({ id: "step:validate", type: "step", name: "校验订单" }),
    ]);

    const index = buildAssistantReferenceIndex(graph([]), domain);

    expect(findAssistantReferenceMatches("支付域 包含 结算流程 和 校验订单。", index).map((match) => match.href)).toEqual([
      "domain:domain%3Abilling",
      "domain:flow%3Acheckout",
      "domain:step%3Avalidate",
    ]);
  });

  it("does not link overly short labels", () => {
    const index = buildAssistantReferenceIndex(
      graph([
        node({ id: "a", type: "concept", name: "A" }),
        node({ id: "zh", type: "concept", name: "域" }),
      ]),
      null,
    );

    expect(findAssistantReferenceMatches("A 域", index)).toEqual([]);
  });
});
