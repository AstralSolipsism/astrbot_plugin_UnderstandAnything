import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import { AssistantMarkdownRenderer } from "../AssistantMarkdownRenderer";
import { buildAssistantReferenceIndex } from "../assistantReferenceIndex";

function node(overrides: Partial<GraphNode> & Pick<GraphNode, "id" | "type" | "name">): GraphNode {
  return {
    summary: `${overrides.name} summary`,
    tags: [],
    complexity: "simple",
    ...overrides,
  };
}

function graph(nodes: GraphNode[]): KnowledgeGraph {
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
    edges: [],
    layers: [],
    tour: [],
  };
}

function renderMarkdown(markdown: string, referenceIndex = buildAssistantReferenceIndex(graph([]), null)): string {
  return renderToStaticMarkup(
    React.createElement(AssistantMarkdownRenderer, { referenceIndex }, markdown),
  );
}

describe("AssistantMarkdownRenderer", () => {
  it("renders GitHub flavored markdown tables, task lists, strikethrough, and autolinks", () => {
    const html = renderMarkdown([
      "| 文件 | 状态 |",
      "| --- | --- |",
      "| src/main.ts | OK |",
      "",
      "- [x] 已完成",
      "- [ ] 待确认",
      "",
      "~~删除线~~ https://example.com",
    ].join("\n"));

    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("<tbody");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("checked=\"\"");
    expect(html).toContain("<del>删除线</del>");
    expect(html).toContain("href=\"https://example.com\"");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("rel=\"noreferrer\"");
  });

  it("renders code blocks with their language class and escapes raw HTML", () => {
    const html = renderMarkdown([
      "```ts",
      "const value = 1;",
      "```",
      "",
      "<span>raw</span>",
    ].join("\n"));

    expect(html).toContain("language-ts");
    expect(html).toContain("const");
    expect(html).toContain("&lt;span&gt;raw&lt;/span&gt;");
    expect(html).not.toContain("<span>raw</span>");
  });

  it("turns known files and nodes into internal reference buttons without touching code blocks", () => {
    const referenceIndex = buildAssistantReferenceIndex(
      graph([
        node({ id: "src/main.ts", type: "file", name: "main.ts", filePath: "src/main.ts" }),
        node({ id: "service:auth", type: "service", name: "AuthService" }),
      ]),
      null,
    );
    const html = renderMarkdown([
      "Open src/main.ts and AuthService.",
      "",
      "```txt",
      "src/main.ts AuthService",
      "```",
    ].join("\n"), referenceIndex);

    expect(html).toContain("data-ua-reference=\"file:src%2Fmain.ts\"");
    expect(html).toContain("data-ua-reference=\"node:service%3Aauth\"");
    expect(html.match(/data-ua-reference=/g)).toHaveLength(2);
  });
});
