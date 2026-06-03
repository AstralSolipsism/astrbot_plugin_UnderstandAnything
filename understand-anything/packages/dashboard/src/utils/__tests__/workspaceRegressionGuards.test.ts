import { describe, expect, it } from "vitest";

import {
  ASTRBOT_WORKSPACE_READ_ENDPOINTS,
  ASTRBOT_WORKSPACE_REQUIRED_ACTIONS,
  analyzeStartBlocker,
  shouldUseJobEventPollingFallback,
} from "../workspaceRegressionGuards";

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
        "projects/delete",
        "projects/ignore",
      ]),
    );
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
});
