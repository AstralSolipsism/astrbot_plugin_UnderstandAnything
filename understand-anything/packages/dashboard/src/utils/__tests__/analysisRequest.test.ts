import { describe, expect, it } from "vitest";

import { buildAnalysisJobPayload, looksLikeGitHubTarget } from "../analysisRequest";

describe("analysis job request payloads", () => {
  it("submits a single target for GitHub repository URLs", () => {
    expect(
      buildAnalysisJobPayload({
        target: " https://github.com/AstralSolipsism/demo/tree/main/packages/app ",
        fullAnalysis: true,
        autoUpdate: false,
        githubProxy: "https://gh.llkk.cc",
      }),
    ).toEqual({
      action: "understand",
      target: "https://github.com/AstralSolipsism/demo/tree/main/packages/app",
      full: true,
      auto_update: false,
      github_proxy: "https://gh.llkk.cc",
    });
  });

  it("submits a single target for server paths", () => {
    expect(
      buildAnalysisJobPayload({
        target: " D:/projects/demo ",
        fullAnalysis: false,
        autoUpdate: true,
        githubProxy: "https://gh.llkk.cc",
      }),
    ).toEqual({
      action: "understand",
      target: "D:/projects/demo",
      full: false,
      auto_update: true,
    });
  });

  it("detects GitHub targets without requiring a source mode toggle", () => {
    expect(looksLikeGitHubTarget(" https://github.com/owner/repo ")).toBe(true);
    expect(looksLikeGitHubTarget("G:/projects/repo")).toBe(false);
  });
});
