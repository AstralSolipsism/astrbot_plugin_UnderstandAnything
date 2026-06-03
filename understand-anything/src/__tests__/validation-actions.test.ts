import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@understand-anything/core/types";
import {
  assistantContextBundleAction,
  compileDomainIrAction,
  preflightInventoryAction,
  validateOutputsAction,
} from "../index.js";

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function graph(): KnowledgeGraph {
  return {
    version: "1.0.0",
    kind: "knowledge",
    project: {
      name: "订单系统",
      languages: ["typescript"],
      frameworks: [],
      description: "这是用于 runtime action 测试的中文项目。",
      analyzedAt: new Date(0).toISOString(),
      gitCommitHash: "commit-a",
    },
    nodes: [
      {
        id: "file:src/app.ts",
        type: "file",
        name: "app.ts",
        filePath: "src/app.ts",
        lineRange: [1, 4],
        summary: "应用入口文件负责启动订单服务。",
        tags: ["入口"],
        complexity: "simple",
      },
    ],
    edges: [],
    layers: [{ id: "layer:app", name: "应用层", description: "应用层说明", nodeIds: ["file:src/app.ts"] }],
    tour: [{ order: 1, title: "入口", description: "入口导览说明", nodeIds: ["file:src/app.ts"] }],
  };
}

function setupProject(): { projectRoot: string; graphRoot: string } {
  const projectRoot = tempDir("ua-action-project-");
  const graphRoot = tempDir("ua-action-graph-");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "app.ts"), "export const value = 1;\n", "utf-8");
  writeFileSync(join(graphRoot, "knowledge-graph.json"), JSON.stringify(graph(), null, 2), "utf-8");
  writeFileSync(join(graphRoot, "meta.json"), JSON.stringify({ gitCommitHash: "commit-a" }, null, 2), "utf-8");
  return { projectRoot, graphRoot };
}

describe("runtime validation action wrappers", () => {
  it("preflightInventoryAction writes source inventory and returns structured observations", () => {
    const { projectRoot, graphRoot } = setupProject();

    const result = preflightInventoryAction({
      projectRoot,
      graphRoot,
      expectedGitCommitHash: "commit-a",
    });

    expect(result.ok).toBe(true);
    expect(result.artifacts).toContain("source-inventory.json");
    expect(result.observations).toContainEqual(expect.objectContaining({
      stage: "source",
      status: "succeeded",
    }));
    const inventory = JSON.parse(readFileSync(join(graphRoot, "source-inventory.json"), "utf-8"));
    expect(inventory.entries.map((item: { path: string }) => item.path)).toContain("src/app.ts");
  });

  it("validateOutputsAction validates graphRoot outputs through the pipeline", () => {
    const { projectRoot, graphRoot } = setupProject();

    const result = validateOutputsAction({
      projectRoot,
      graphRoot,
      jobId: "job-1",
      jobKind: "understand",
      locale: "zh-CN",
      expectedGitCommitHash: "commit-a",
    });

    expect(result.ok).toBe(true);
    expect(result.artifacts).toEqual(expect.arrayContaining([
      "knowledge-graph.json",
      "source-inventory.json",
      "fingerprints.json",
      "quality-report.json",
    ]));
  });

  it("compileDomainIrAction compiles intermediate DomainAnalysisIR through the validation pipeline", () => {
    const { projectRoot, graphRoot } = setupProject();
    mkdirSync(join(graphRoot, "intermediate"), { recursive: true });
    writeFileSync(
      join(graphRoot, "intermediate", "domain-analysis.json"),
      JSON.stringify({
        version: "1.0.0",
        domains: [
          {
            id: "orders",
            name: "订单管理",
            summary: "负责订单服务的启动和订单处理入口。",
            sourceFilePaths: ["src/app.ts"],
            flows: [],
          },
        ],
      }, null, 2),
      "utf-8",
    );

    const result = compileDomainIrAction({
      projectRoot,
      graphRoot,
      jobId: "job-domain",
      locale: "zh-CN",
      expectedGitCommitHash: "commit-a",
    });

    expect(result.ok).toBe(true);
    expect(result.artifacts).toEqual(expect.arrayContaining([
      "intermediate/domain-analysis.json",
      "domain-graph.json",
      "quality-report.json",
    ]));
    const domainGraph = JSON.parse(readFileSync(join(graphRoot, "domain-graph.json"), "utf-8"));
    expect(domainGraph.nodes[0]).toMatchObject({
      id: "domain:orders",
      type: "domain",
    });
  });

  it("assistantContextBundleAction sanitizes paths and builds an AstrBot assistant prompt", () => {
    const { projectRoot, graphRoot } = setupProject();
    const secretPath = process.platform === "win32" ? "D:/secret/app.ts" : "/data/projects/secret/app.ts";

    const result = assistantContextBundleAction({
      projectRoot,
      graphRoot,
      mode: "chat",
      messages: [{ role: "user", content: "入口文件做什么？" }],
      items: [
        { type: "file", path: "src/app.ts", label: "app.ts" },
        { type: "code-range", path: "src/app.ts", startLine: 1, endLine: 20 },
        { type: "file", path: "../outside.ts", label: "outside" },
        { type: "file", path: secretPath, label: "secret" },
      ],
    });
    const legacyAssistantName = ["Ki", "mi"].join("");

    expect(result.ok).toBe(true);
    expect(result.prompt).toContain("AstrBot Provider");
    expect(result.prompt).not.toContain(legacyAssistantName);
    expect(JSON.stringify(result)).not.toContain(secretPath.replace(/\\/g, "/"));
    expect(result.context.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "file", path: "src/app.ts" }),
      expect.objectContaining({ type: "code-range", path: "src/app.ts" }),
    ]));
    expect(result.context.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "../outside.ts" }),
      expect.objectContaining({ path: secretPath }),
    ]));
    expect(result.context.sourceSnippets[0]).toEqual(expect.objectContaining({
      path: "src/app.ts",
      language: "typescript",
    }));
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });
});
