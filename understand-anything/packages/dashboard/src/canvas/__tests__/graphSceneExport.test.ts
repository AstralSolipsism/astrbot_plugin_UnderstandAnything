import { describe, expect, it } from "vitest";
import { buildGraphSceneSvg } from "../graphSceneExport";
import type { GraphSceneModel } from "../../graph-scene/graphSceneTypes";

function scene(): GraphSceneModel {
  return {
    level: "overview",
    nodes: [
      {
        id: "layer:api",
        kind: "layer-cluster",
        x: 100,
        y: 50,
        width: 320,
        height: 180,
        data: {
          layerName: "API Layer",
        },
        state: {
          selected: false,
          highlighted: false,
          searchMatched: false,
          diffChanged: false,
          diffAffected: false,
          faded: false,
          focused: false,
        },
      },
      {
        id: "layer:core",
        kind: "layer-cluster",
        x: 520,
        y: 80,
        width: 320,
        height: 180,
        data: {
          layerName: "Core Layer",
        },
        state: {
          selected: false,
          highlighted: false,
          searchMatched: false,
          diffChanged: false,
          diffAffected: false,
          faded: false,
          focused: false,
        },
      },
    ],
    edges: [
      {
        id: "edge:1",
        source: "layer:api",
        target: "layer:core",
        label: "2",
        style: {
          stroke: "rgba(212,165,116,0.4)",
          strokeWidth: 2,
        },
        state: {
          selected: false,
          faded: false,
          highlighted: false,
        },
      },
    ],
  };
}

describe("graph scene export", () => {
  it("builds an SVG from canvas scene cards and edges", () => {
    const result = buildGraphSceneSvg(scene());

    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.width).toBe(820);
    expect(result.height).toBe(290);
    expect(result.svgContent).toContain('<rect width="100%" height="100%" fill="#0a0a0a"/>');
    expect(result.svgContent).toContain('stroke="rgba(212,165,116,0.4)"');
    expect(result.svgContent).toContain(">API Layer</text>");
    expect(result.svgContent).toContain(">Core Layer</text>");
    expect(result.svgContent).toContain(">2</text>");
  });
});
