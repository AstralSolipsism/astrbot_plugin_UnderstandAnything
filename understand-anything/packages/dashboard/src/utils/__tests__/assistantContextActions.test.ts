import { describe, expect, it } from "vitest";
import {
  buildCodeLineAssistantContextItem,
  buildFileAssistantContextItem,
} from "../assistantContextActions";

describe("assistant context explicit actions", () => {
  it("builds explicit file context items", () => {
    expect(buildFileAssistantContextItem({
      path: "src/main.ts",
      nodeId: "src/main.ts",
      graphKind: "knowledge",
    })).toEqual({
      type: "file",
      path: "src/main.ts",
      label: "src/main.ts",
      nodeId: "src/main.ts",
      graphKind: "knowledge",
    });
  });

  it("builds explicit code line context items", () => {
    expect(buildCodeLineAssistantContextItem({
      path: "src/main.ts",
      lineNumber: 12,
      nodeId: "fn:init",
      graphKind: "domain",
    })).toEqual({
      type: "code-range",
      path: "src/main.ts",
      startLine: 12,
      endLine: 12,
      label: "src/main.ts:12",
      nodeId: "fn:init",
      graphKind: "domain",
    });
  });
});
