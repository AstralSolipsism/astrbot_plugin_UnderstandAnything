import { describe, expect, it } from "vitest";
import { getGraphLevelOfDetail } from "../graphLevelOfDetail";

describe("getGraphLevelOfDetail", () => {
  it("hides labels and edges at very low zoom", () => {
    expect(getGraphLevelOfDetail(0.2)).toMatchObject({
      showLabels: false,
      showEdges: false,
      showEdgeLabels: false,
      nodeRadius: 3,
    });
  });

  it("draws edges but keeps labels hidden at middle zoom", () => {
    expect(getGraphLevelOfDetail(0.7)).toMatchObject({
      showLabels: false,
      showEdges: true,
      showEdgeLabels: false,
    });
  });

  it("shows labels and keeps edge labels gated at high zoom", () => {
    expect(getGraphLevelOfDetail(1.4)).toMatchObject({
      showLabels: true,
      showEdges: true,
      showEdgeLabels: true,
    });
  });

  it("normalizes invalid zoom values to a safe low-zoom policy", () => {
    expect(getGraphLevelOfDetail(Number.NaN)).toMatchObject({
      showLabels: false,
      showEdges: false,
    });
  });
});
