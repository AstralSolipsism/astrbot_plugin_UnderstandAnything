import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import { describe, expect, it } from "vitest";
import { resolveAssistantReferenceTarget } from "../assistantReferenceNavigation";

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

describe("assistant markdown reference navigation", () => {
  const knowledge = graph([
    node({ id: "src/main.ts", type: "file", name: "main.ts", filePath: "src/main.ts" }),
    node({
      id: "fn:init",
      type: "function",
      name: "init",
      filePath: "src/main.ts",
      lineRange: [10, 30],
    }),
  ]);
  const domain = graph(
    [
      node({ id: "domain:billing", type: "domain", name: "支付域" }),
      node({ id: "flow:checkout", type: "flow", name: "结算流程" }),
      node({ id: "step:validate", type: "step", name: "校验订单" }),
    ],
    [
      { source: "domain:billing", target: "flow:checkout", type: "contains_flow", direction: "forward", weight: 1 },
      { source: "flow:checkout", target: "step:validate", type: "flow_step", direction: "forward", weight: 1 },
    ],
  );

  it("resolves node, file, and code-range hrefs", () => {
    expect(resolveAssistantReferenceTarget("node:fn%3Ainit", knowledge, domain)).toEqual({
      type: "node",
      nodeId: "fn:init",
    });
    expect(resolveAssistantReferenceTarget("file:src%2Fmain.ts", knowledge, domain)).toEqual({
      type: "file",
      path: "src/main.ts",
      nodeId: "src/main.ts",
    });
    expect(resolveAssistantReferenceTarget("code-range:src%2Fmain.ts:12-24", knowledge, domain)).toEqual({
      type: "code-range",
      path: "src/main.ts",
      startLine: 12,
      endLine: 24,
      nodeId: "fn:init",
    });
  });

  it("resolves domain, flow, and step hrefs with parent domain context", () => {
    expect(resolveAssistantReferenceTarget("domain:domain%3Abilling", knowledge, domain)).toEqual({
      type: "domain",
      nodeId: "domain:billing",
      nodeType: "domain",
      domainId: "domain:billing",
    });
    expect(resolveAssistantReferenceTarget("domain:flow%3Acheckout", knowledge, domain)).toEqual({
      type: "domain",
      nodeId: "flow:checkout",
      nodeType: "flow",
      domainId: "domain:billing",
    });
    expect(resolveAssistantReferenceTarget("domain:step%3Avalidate", knowledge, domain)).toEqual({
      type: "domain",
      nodeId: "step:validate",
      nodeType: "step",
      domainId: "domain:billing",
    });
  });

  it("returns null for references that do not resolve", () => {
    expect(resolveAssistantReferenceTarget("file:missing.ts", knowledge, domain)).toBeNull();
    expect(resolveAssistantReferenceTarget("domain:missing", knowledge, domain)).toBeNull();
    expect(resolveAssistantReferenceTarget("https://example.com", knowledge, domain)).toBeNull();
  });
});
