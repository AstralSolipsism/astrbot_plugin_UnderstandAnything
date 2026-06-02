import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@understand-anything/core/types";
import { validateProjectOutputs } from "../output-pipeline.js";

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

function knowledgeGraph(): KnowledgeGraph {
  return {
    version: "1.0.0",
    kind: "knowledge",
    project: {
      name: "订单系统",
      languages: ["typescript"],
      frameworks: [],
      description: "这是用于验证 AstrBot 图谱产物管线的中文项目。",
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
      {
        id: "function:start",
        type: "function",
        name: "start",
        filePath: "src/app.ts",
        lineRange: [1, 3],
        summary: "启动订单服务并输出状态。",
        tags: ["启动"],
        complexity: "simple",
      },
    ],
    edges: [
      { source: "file:src/app.ts", target: "function:start", type: "contains", direction: "forward", weight: 1 },
    ],
    layers: [
      {
        id: "layer:app",
        name: "应用层",
        description: "应用层包含启动入口。",
        nodeIds: ["file:src/app.ts", "function:start"],
      },
    ],
    tour: [
      {
        order: 1,
        title: "启动入口",
        description: "从应用入口理解订单服务启动流程。",
        nodeIds: ["file:src/app.ts"],
      },
    ],
  };
}

describe("runtime output validation pipeline", () => {
  it("validates graphRoot artifacts and writes inventory fingerprints and quality report to graphRoot", () => {
    const projectRoot = tempDir("ua-project-");
    const graphRoot = tempDir("ua-graph-");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(graphRoot, { recursive: true });
    writeFileSync(join(projectRoot, "src", "app.ts"), "export function start() {\n  return 'ok';\n}\n", "utf-8");
    writeFileSync(join(graphRoot, "knowledge-graph.json"), JSON.stringify(knowledgeGraph(), null, 2), "utf-8");
    writeFileSync(join(graphRoot, "meta.json"), JSON.stringify({ gitCommitHash: "commit-a" }, null, 2), "utf-8");

    const result = validateProjectOutputs({
      projectRoot,
      graphRoot,
      jobId: "job-1",
      jobKind: "understand",
      locale: "zh-CN",
      expectedGitCommitHash: "commit-a",
    });

    expect(result.fatal).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.artifacts).toEqual(expect.arrayContaining([
      "knowledge-graph.json",
      "meta.json",
      "source-inventory.json",
      "fingerprints.json",
      "quality-report.json",
    ]));
    expect(result.observations.map((item) => item.stage)).toEqual(expect.arrayContaining([
      "source",
      "validate",
    ]));

    const inventory = JSON.parse(readFileSync(join(graphRoot, "source-inventory.json"), "utf-8"));
    const fingerprints = JSON.parse(readFileSync(join(graphRoot, "fingerprints.json"), "utf-8"));
    const report = JSON.parse(readFileSync(join(graphRoot, "quality-report.json"), "utf-8"));

    expect(inventory.entries.map((item: { path: string }) => item.path)).toContain("src/app.ts");
    expect(Object.keys(fingerprints.files)).toEqual(["src/app.ts"]);
    expect(report.issueCounts.fatal).toBe(0);
    expect(report.issueCounts.error).toBe(0);
  });

  it("uses graphRoot .understandignore when building inventory and fingerprints", () => {
    const projectRoot = tempDir("ua-project-");
    const graphRoot = tempDir("ua-graph-");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(graphRoot, { recursive: true });
    writeFileSync(join(projectRoot, "src", "app.ts"), "export function start() {\n  return 'ok';\n}\n", "utf-8");
    writeFileSync(join(projectRoot, "src", "ignored.ts"), "export const ignored = true;\n", "utf-8");
    writeFileSync(join(graphRoot, ".understandignore"), "src/ignored.ts\n", "utf-8");
    writeFileSync(join(graphRoot, "knowledge-graph.json"), JSON.stringify(knowledgeGraph(), null, 2), "utf-8");
    writeFileSync(join(graphRoot, "meta.json"), JSON.stringify({ gitCommitHash: "commit-a" }, null, 2), "utf-8");

    const result = validateProjectOutputs({
      projectRoot,
      graphRoot,
      jobId: "job-ignore",
      jobKind: "understand",
      locale: "zh-CN",
      expectedGitCommitHash: "commit-a",
    });

    const inventory = JSON.parse(readFileSync(join(graphRoot, "source-inventory.json"), "utf-8"));
    const fingerprints = JSON.parse(readFileSync(join(graphRoot, "fingerprints.json"), "utf-8"));

    expect(result.ok).toBe(true);
    expect(inventory.entries.map((item: { path: string }) => item.path)).not.toContain("src/ignored.ts");
    expect(Object.keys(fingerprints.files)).toEqual(["src/app.ts"]);
  });

  it("fails Chinese validation when visible graph content is not Chinese", () => {
    const projectRoot = tempDir("ua-project-");
    const graphRoot = tempDir("ua-graph-");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "app.ts"), "export function start() { return 'ok'; }\n", "utf-8");
    const graph = knowledgeGraph();
    graph.project.description = "This project is described in English.";
    graph.nodes[0].summary = "Application entry point.";
    graph.nodes[1].summary = "Starts the service.";
    graph.layers[0].description = "Application layer.";
    graph.tour[0].description = "Start here.";
    writeFileSync(join(graphRoot, "knowledge-graph.json"), JSON.stringify(graph, null, 2), "utf-8");
    writeFileSync(join(graphRoot, "meta.json"), JSON.stringify({ gitCommitHash: "commit-a" }, null, 2), "utf-8");

    const result = validateProjectOutputs({
      projectRoot,
      graphRoot,
      jobId: "job-2",
      jobKind: "understand",
      locale: "zh-CN",
      expectedGitCommitHash: "commit-a",
    });

    expect(result.ok).toBe(false);
    expect(result.fatal).toMatch(/中文|Chinese/);
    expect(result.observations).toContainEqual(expect.objectContaining({
      level: "error",
      stage: "validate",
    }));
  });
});
