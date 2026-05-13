import { describe, expect, it } from "vitest";

import type { KnowledgeGraph } from "@understand-anything/core";
import { formatDiffAnalysis, type DiffContext } from "../diff-analyzer";
import { formatExplainPrompt, type ExplainContext } from "../explain-builder";
import { buildOnboardingGuide } from "../onboard-builder";
import { buildChatPrompt } from "../understand-chat";

const languageDirective =
  "Generate all user-visible textual content in Simplified Chinese. Keep code identifiers, file paths, schema keys, tags, and established technical terms unchanged when appropriate.";

const graph = {
  version: "1.0.0",
  project: {
    name: "Demo",
    description: "Demo project",
    languages: ["typescript"],
    frameworks: ["react"],
    analyzedAt: "2026-05-13T00:00:00Z",
    gitCommitHash: "abc123",
  },
  nodes: [],
  edges: [],
  layers: [],
  tour: [],
} as unknown as KnowledgeGraph;

describe("prompt language directives", () => {
  it("adds language guidance to chat prompts", () => {
    const prompt = buildChatPrompt(graph, "What does this do?", {
      languageDirective,
      targetLanguage: "Simplified Chinese",
    });

    expect(prompt).toContain(languageDirective);
  });

  it("adds language guidance to explain prompts", () => {
    const ctx = {
      projectName: "Demo",
      path: "src/app.ts",
      targetNode: null,
      childNodes: [],
      connectedNodes: [],
      relevantEdges: [],
      layer: null,
    } satisfies ExplainContext;

    const prompt = formatExplainPrompt(ctx, {
      languageDirective,
      targetLanguage: "Simplified Chinese",
    });

    expect(prompt).toContain(languageDirective);
  });

  it("adds language guidance to diff prompts", () => {
    const ctx = {
      projectName: "Demo",
      changedFiles: ["src/app.ts"],
      changedNodes: [],
      affectedNodes: [],
      impactedEdges: [],
      affectedLayers: [],
      unmappedFiles: [],
    } satisfies DiffContext;

    const prompt = formatDiffAnalysis(ctx, {
      languageDirective,
      targetLanguage: "Simplified Chinese",
    });

    expect(prompt).toContain(languageDirective);
  });

  it("adds language guidance to onboarding prompts", () => {
    const prompt = buildOnboardingGuide(graph, {
      languageDirective,
      targetLanguage: "Simplified Chinese",
    });

    expect(prompt).toContain(languageDirective);
  });
});
