import { beforeEach, describe, expect, it } from "vitest";
import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import { assistantContextKey, useDashboardStore } from "../../store";

function node(overrides: Partial<GraphNode> & Pick<GraphNode, "id" | "type" | "name">): GraphNode {
  return {
    summary: `${overrides.name} 摘要`,
    tags: [],
    complexity: "simple",
    ...overrides,
  };
}

function graph(name: "knowledge" | "domain", nodes: GraphNode[], edges: KnowledgeGraph["edges"] = []): KnowledgeGraph {
  return {
    version: "1.0.0",
    kind: "knowledge",
    project: {
      name,
      languages: ["typescript"],
      frameworks: [],
      description: "测试图谱",
      analyzedAt: new Date(0).toISOString(),
      gitCommitHash: name,
    },
    nodes,
    edges,
    layers: [],
    tour: [],
  };
}

describe("assistant context selection", () => {
  beforeEach(() => {
    useDashboardStore.getState().clearProjectData();
  });

  it("selects a knowledge node without adding assistant context", () => {
    const knowledge = graph("knowledge", [
      node({
        id: "src/main.ts",
        type: "file",
        name: "main.ts",
        filePath: "src/main.ts",
      }),
    ]);

    const state = useDashboardStore.getState();
    state.setGraph(knowledge);
    state.selectNode("src/main.ts");

    expect(useDashboardStore.getState().selectedNodeId).toBe("src/main.ts");
    expect(useDashboardStore.getState().assistantContextItems).toEqual([]);
  });

  it("adds knowledge node and file context when explicitly requested", () => {
    const knowledge = graph("knowledge", [
      node({
        id: "src/main.ts",
        type: "file",
        name: "main.ts",
        filePath: "src/main.ts",
      }),
    ]);

    const state = useDashboardStore.getState();
    state.setGraph(knowledge);
    state.addGraphNodeToAssistantContext("src/main.ts");

    expect(useDashboardStore.getState().selectedNodeId).toBeNull();
    expect(useDashboardStore.getState().assistantContextItems).toEqual([
      {
        type: "node",
        nodeId: "src/main.ts",
        label: "main.ts",
        filePath: "src/main.ts",
        graphKind: "knowledge",
      },
      {
        type: "file",
        path: "src/main.ts",
        label: "src/main.ts",
        nodeId: "src/main.ts",
        graphKind: "knowledge",
      },
    ]);
  });

  it("keeps navigation and code viewer opening as browsing-only actions", () => {
    const knowledge = graph("knowledge", [
      node({
        id: "src/main.ts",
        type: "file",
        name: "main.ts",
        filePath: "src/main.ts",
      }),
    ]);

    const state = useDashboardStore.getState();
    state.setGraph(knowledge);
    state.navigateToNode("src/main.ts");
    state.openCodeViewer("src/main.ts");

    expect(useDashboardStore.getState().selectedNodeId).toBe("src/main.ts");
    expect(useDashboardStore.getState().codeViewerOpen).toBe(true);
    expect(useDashboardStore.getState().assistantContextItems).toEqual([]);
  });

  it("selects a domain graph node without adding assistant context", () => {
    const domain = graph("domain", [
      node({
        id: "step:compress",
        type: "step",
        name: "选择候选",
        filePath: "src/functions/compress.ts",
        lineRange: [12, 24],
        domainMeta: { evidence: ["来自压缩流程"] },
      }),
    ]);

    const state = useDashboardStore.getState();
    state.setGraph(graph("knowledge", []));
    state.setDomainGraph(domain);
    state.setViewMode("domain");
    state.selectNode("step:compress", "domain");

    expect(useDashboardStore.getState().selectedNodeId).toBe("step:compress");
    expect(useDashboardStore.getState().assistantContextItems).toEqual([]);
  });

  it("adds domain node and code range context when explicitly requested", () => {
    const domain = graph("domain", [
      node({
        id: "step:compress",
        type: "step",
        name: "选择候选",
        filePath: "src/functions/compress.ts",
        lineRange: [12, 24],
        domainMeta: { evidence: ["来自压缩流程"] },
      }),
    ]);

    const state = useDashboardStore.getState();
    state.setGraph(graph("knowledge", []));
    state.setDomainGraph(domain);
    state.setViewMode("domain");
    state.addGraphNodeToAssistantContext("step:compress", "domain");

    expect(useDashboardStore.getState().selectedNodeId).toBeNull();
    expect(useDashboardStore.getState().assistantContextItems).toEqual([
      {
        type: "node",
        nodeId: "step:compress",
        label: "选择候选",
        filePath: "src/functions/compress.ts",
        graphKind: "domain",
      },
      {
        type: "code-range",
        path: "src/functions/compress.ts",
        startLine: 12,
        endLine: 24,
        label: "src/functions/compress.ts:12-24",
        nodeId: "step:compress",
        graphKind: "domain",
      },
    ]);
  });

  it("adds source files for domain nodes without a direct filePath when explicitly requested", () => {
    const domain = graph("domain", [
      node({
        id: "flow:compress",
        type: "flow",
        name: "智能压缩",
        domainMeta: {
          sourceFilePaths: ["src/functions/compress.ts", "src/functions/compress-file.ts"],
          scopePath: "src/functions",
          evidence: "流程来自真实函数文件",
        },
      }),
    ]);

    const state = useDashboardStore.getState();
    state.setGraph(graph("knowledge", []));
    state.setDomainGraph(domain);
    state.setViewMode("domain");
    state.addGraphNodeToAssistantContext("flow:compress", "domain");
    state.addGraphNodeToAssistantContext("flow:compress", "domain");

    expect(useDashboardStore.getState().assistantContextItems).toEqual([
      {
        type: "node",
        nodeId: "flow:compress",
        label: "智能压缩",
        filePath: undefined,
        graphKind: "domain",
      },
      {
        type: "file",
        path: "src/functions/compress.ts",
        label: "src/functions/compress.ts",
        nodeId: "flow:compress",
        graphKind: "domain",
      },
      {
        type: "file",
        path: "src/functions/compress-file.ts",
        label: "src/functions/compress-file.ts",
        nodeId: "flow:compress",
        graphKind: "domain",
      },
    ]);
  });

  it("keeps scope-only domain nodes as node context without inventing files when explicitly requested", () => {
    const domain = graph("domain", [
      node({
        id: "domain:memory",
        type: "domain",
        name: "记忆域",
        domainMeta: {
          scopePath: "src/functions",
          evidence: ["目录级业务范围"],
        },
      }),
    ]);

    const state = useDashboardStore.getState();
    state.setGraph(graph("knowledge", []));
    state.setDomainGraph(domain);
    state.setViewMode("domain");
    state.addGraphNodeToAssistantContext("domain:memory", "domain");

    expect(useDashboardStore.getState().assistantContextItems).toEqual([
      {
        type: "node",
        nodeId: "domain:memory",
        label: "记忆域",
        filePath: undefined,
        graphKind: "domain",
      },
    ]);
  });

  it("keeps backend-restored domain source file context marked as domain", () => {
    const state = useDashboardStore.getState();
    state.setAssistantContextItems([
      {
        type: "file",
        path: "src/functions/compress.ts",
        label: "src/functions/compress.ts",
        nodeId: "flow:compress",
        graphKind: "domain",
      },
    ]);

    expect(useDashboardStore.getState().assistantContextItems).toEqual([
      {
        type: "file",
        path: "src/functions/compress.ts",
        label: "src/functions/compress.ts",
        nodeId: "flow:compress",
        graphKind: "domain",
      },
    ]);
    expect(assistantContextKey(useDashboardStore.getState().assistantContextItems[0]!)).toBe("file:domain:src/functions/compress.ts");
  });
});
