import { readFileSync, readdirSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ASTRBOT_RUNTIME_DEPENDENCY_ITEMS,
  ASTRBOT_WORKSPACE_READ_ENDPOINTS,
  ASTRBOT_WORKSPACE_REQUIRED_ACTIONS,
  analyzeStartBlocker,
  shouldUseJobEventPollingFallback,
} from "../workspaceRegressionGuards";

function collectDashboardSourceFiles(root: URL): URL[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    if (entry.isDirectory()) {
      return collectDashboardSourceFiles(child);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) && statSync(child).isFile() ? [child] : [];
  });
}

const readyInput = {
  target: "D:/demo",
  subagentError: null,
  subagentsReady: true,
  computerUseReady: true,
  localRuntimeReady: true,
  runtimeBlockingReasons: [],
  projectTargetRequiredMessage: "请选择项目路径或 GitHub 仓库。",
  subagentsRequiredMessage: "请先注册 UA SubAgents。",
  computerUseRequiredMessage: "请先启用 Computer Use 运行环境。",
  runtimeUnavailableMessage: "Runtime unavailable",
  githubAnalysisReady: true,
  githubBlockingReason: "",
  gitUnavailableMessage: "Git unavailable",
};

describe("AstrBot workspace regression guards", () => {
  it("keeps status, project, job, SubAgent, and source-preview bridge reads as required", () => {
    expect(ASTRBOT_WORKSPACE_READ_ENDPOINTS).toEqual([
      "status",
      "projects",
      "jobs",
      "subagents/status",
      "file-content",
    ]);
  });

  it("keeps repair, provider registration, job confirmation, and project actions discoverable", () => {
    expect(ASTRBOT_WORKSPACE_REQUIRED_ACTIONS).toEqual(
      expect.arrayContaining([
        "runtime/repair",
        "subagents/providers",
        "subagents/register",
        "jobs/start",
        "jobs/<job_id>",
        "jobs/<job_id>/events",
        "jobs/<job_id>/confirm",
        "jobs/<job_id>/retry",
        "projects/delete",
        "projects/check-updates",
        "projects/ignore",
      ]),
    );
  });

  it("keeps project-scoped GitHub storage out of the runtime dependency checklist", () => {
    const statusKeys = ASTRBOT_RUNTIME_DEPENDENCY_ITEMS.map((item) => item.statusKey);
    const workspaceSource = readFileSync(
      new URL("../../components/AstrBotWorkspace.tsx", import.meta.url),
      "utf8",
    );

    expect(statusKeys).toEqual([
      "runtime_dist",
      "core_dist",
      "assistant_dist",
      "dashboard_dist",
      "dashboard_page",
      "node_modules",
    ]);
    expect(statusKeys).not.toContain("github_cache_root");
    expect(statusKeys).not.toContain("github_artifact_root");
    expect(workspaceSource).toContain("ASTRBOT_RUNTIME_DEPENDENCY_ITEMS");
    expect(workspaceSource).not.toContain("runtimeItems.githubCacheRoot");
    expect(workspaceSource).not.toContain("runtimeItems.githubArtifactRoot");
  });

  it("keeps the project creation panel controlled by the explicit toggle state", () => {
    const workspaceSource = readFileSync(
      new URL("../../components/AstrBotWorkspace.tsx", import.meta.url),
      "utf8",
    );

    expect(workspaceSource).not.toContain("createProjectOpen || projects.length === 0");
    expect(workspaceSource).toContain("const showCreateProjectForm = createProjectOpen;");
  });

  it("refreshes projects after a successful analysis start before closing the creation panel", () => {
    const workspaceSource = readFileSync(
      new URL("../../components/AstrBotWorkspace.tsx", import.meta.url),
      "utf8",
    );
    const startIndex = workspaceSource.indexOf("const startAnalysisForTarget = async");
    const restartIndex = workspaceSource.indexOf("const restartProject = async", startIndex);
    const startAnalysisSource = workspaceSource.slice(startIndex, restartIndex);

    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(restartIndex).toBeGreaterThan(startIndex);
    expect(startAnalysisSource).toContain("recordStartedJob(job);");
    expect(startAnalysisSource).toContain("await loadWorkspace();");
    expect(startAnalysisSource.indexOf("recordStartedJob(job);")).toBeLessThan(
      startAnalysisSource.indexOf("await loadWorkspace();"),
    );
    expect(startAnalysisSource.indexOf("await loadWorkspace();")).toBeLessThan(
      startAnalysisSource.indexOf("setCreateProjectOpen(false);"),
    );
  });

  it("keeps domain view opening visible and routes missing-domain recovery through full analysis", () => {
    const workspaceSource = readFileSync(
      new URL("../../components/AstrBotWorkspace.tsx", import.meta.url),
      "utf8",
    );

    expect(workspaceSource).toContain("function domainGraphReady(project: ProjectSummary)");
    expect(workspaceSource).toContain("const startDomainAnalysis = async");
    expect(workspaceSource).toContain('action: "understand"');
    expect(workspaceSource).not.toContain('action: "understand-domain"');
    expect(workspaceSource).toContain('openProjectGraph(selectedProject, "domain")');
    expect(workspaceSource).toContain("workspace.capabilityDomain");
    expect(workspaceSource).not.toContain(["fetch(\"", "api", ""].join("/"));
  });

  it("blocks analysis with the user-facing setup reason before calling jobs/start", () => {
    expect(analyzeStartBlocker({ ...readyInput, target: "" })).toBe(
      "请选择项目路径或 GitHub 仓库。",
    );
    expect(analyzeStartBlocker({ ...readyInput, subagentError: "SubAgent route missing" })).toBe(
      "SubAgent route missing",
    );
    expect(analyzeStartBlocker({ ...readyInput, subagentsReady: false })).toBe(
      "请先注册 UA SubAgents。",
    );
    expect(analyzeStartBlocker({ ...readyInput, computerUseReady: false })).toBe(
      "请先启用 Computer Use 运行环境。",
    );
    expect(
      analyzeStartBlocker({
        ...readyInput,
        localRuntimeReady: false,
        runtimeBlockingReasons: ["Node.js was not found.", "Runtime dist missing."],
      }),
    ).toBe("Node.js was not found. Runtime dist missing.");
    expect(
      analyzeStartBlocker({
        ...readyInput,
        target: "https://github.com/owner/repo",
        githubAnalysisReady: false,
        githubBlockingReason: "Git was not found.",
      }),
    ).toBe("Git was not found.");
  });

  it("allows analysis only after all AstrBot-native setup gates are ready", () => {
    expect(analyzeStartBlocker(readyInput)).toBeNull();
  });

  it("falls back to polling when the AstrBot Plugin Page SSE bridge is unavailable or fails", () => {
    expect(shouldUseJobEventPollingFallback({ hasSubscribeSSE: false })).toBe(true);
    expect(shouldUseJobEventPollingFallback({ hasSubscribeSSE: true, subscribeFailed: true })).toBe(true);
    expect(shouldUseJobEventPollingFallback({ hasSubscribeSSE: true, subscribeFailed: false })).toBe(false);
  });

  it("keeps dashboard source free of raw server route literals", () => {
    const forbiddenNeedle = ["/", "api", "/"].join("");
    const sourceRoot = new URL("../../", import.meta.url);
    const violations = collectDashboardSourceFiles(sourceRoot)
      .map((file) => ({
        file: file.pathname,
        source: readFileSync(file, "utf8"),
      }))
      .filter((entry) => entry.source.includes(forbiddenNeedle))
      .map((entry) => entry.file);

    expect(violations).toEqual([]);
  });
});
