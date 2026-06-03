import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeGraph } from "@understand-anything/core/types";
import { ALL_NODE_TYPES, useDashboardStore } from "../../store";

function graph(id: string): KnowledgeGraph {
  return {
    version: "1",
    kind: "knowledge",
    project: {
      name: id,
      languages: ["typescript"],
      frameworks: [],
      description: "测试图谱",
      analyzedAt: new Date(0).toISOString(),
      gitCommitHash: id,
    },
    nodes: [
      {
        id: `${id}:node`,
        type: "file",
        name: "index.ts",
        filePath: "src/index.ts",
        summary: "入口文件",
        tags: [],
        complexity: "simple",
      },
    ],
    edges: [],
    layers: [
      {
        id: `${id}:layer`,
        name: "源代码",
        description: "源码层",
        nodeIds: [`${id}:node`],
      },
    ],
    tour: [],
  };
}

describe("project-scoped dashboard state", () => {
  beforeEach(() => {
    useDashboardStore.getState().clearProjectData();
  });

  it("clears graph, domain, diff, filters, selection and code viewer between projects", () => {
    const oldGraph = graph("old");
    const state = useDashboardStore.getState();
    state.setGraph(oldGraph);
    state.setDomainGraph(oldGraph);
    state.setDiffOverlay(["old:node"], ["old:affected"]);
    state.setDiffFiles([{ path: "src/index.ts", status: "modified" }]);
    state.setFilters({ layerIds: new Set(["old:layer"]), nodeTypes: new Set(["file"]) });
    state.selectNode("old:node");
    state.setAssistantSessionId("old-session");
    state.setAssistantMessages([{ id: "msg", role: "user", parts: [{ type: "text", text: "解释入口" }] }]);
    state.setAssistantArtifacts([
      {
        id: "artifact",
        kind: "explain",
        title: "解释",
        content: "入口说明",
        createdAt: new Date(0).toISOString(),
      },
    ]);
    state.openCodeViewer("old:node");
    state.setViewMode("domain");

    useDashboardStore.getState().clearProjectData();
    const cleared = useDashboardStore.getState();

    expect(cleared.graph).toBeNull();
    expect(cleared.domainGraph).toBeNull();
    expect(cleared.nodesById.size).toBe(0);
    expect(cleared.nodeIdToLayerId.size).toBe(0);
    expect(cleared.changedNodeIds.size).toBe(0);
    expect(cleared.affectedNodeIds.size).toBe(0);
    expect(cleared.changedDiffFiles).toEqual([]);
    expect(cleared.assistantSessionId).toBeNull();
    expect(cleared.assistantMessages).toEqual([]);
    expect(cleared.assistantContextItems).toEqual([]);
    expect(cleared.assistantArtifacts).toEqual([]);
    expect(cleared.filters.layerIds.size).toBe(0);
    expect(cleared.filters.nodeTypes.size).toBe(ALL_NODE_TYPES.length);
    expect(cleared.selectedNodeId).toBeNull();
    expect(cleared.codeViewerOpen).toBe(false);
    expect(cleared.codeViewerNodeId).toBeNull();
    expect(cleared.viewMode).toBe("structural");
  });

  it("falls back to synchronous search when sandboxing blocks worker creation", () => {
    const originalWorker = globalThis.Worker;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    class BlockedWorker {
      constructor() {
        throw new DOMException("Blocked by sandbox", "SecurityError");
      }
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: BlockedWorker,
    });

    try {
      const state = useDashboardStore.getState();
      state.setSearchQuery("index");
      state.setGraph(graph("blocked-worker"));

      const updated = useDashboardStore.getState();
      expect(updated.searchEngine).not.toBeNull();
      expect(updated.searchResults.map((result) => result.nodeId)).toEqual([
        "blocked-worker:node",
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        "[search-worker] disabled: Blocked by sandbox",
      );
    } finally {
      warnSpy.mockRestore();
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: originalWorker,
      });
    }
  });
});
