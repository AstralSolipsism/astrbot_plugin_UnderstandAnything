import { describe, expect, it } from "vitest";
import {
  describeGraphLoadError,
  hasProjectRef,
  projectParamsFromProject,
  projectParamsFromSearch,
  unwrapPluginPayload,
} from "../astrbotBridge";

describe("AstrBot bridge helpers", () => {
  it("opens the workspace when no project reference is present", () => {
    const params = projectParamsFromSearch("");

    expect(params).toBeUndefined();
    expect(hasProjectRef(params)).toBe(false);
  });

  it("extracts URL project references and preserves legacy path links", () => {
    expect(projectParamsFromSearch("?project_id=abc")).toEqual({
      project_id: "abc",
    });
    expect(projectParamsFromSearch("?path=D%3A%5CProject%20With%20Spaces")).toEqual({
      project_path: "D:\\Project With Spaces",
    });
  });

  it("builds graph params from a selected project", () => {
    expect(projectParamsFromProject({ project_id: "p1" })).toEqual({
      project_id: "p1",
    });
  });

  it("unwraps plugin envelopes before graph validation", () => {
    expect(unwrapPluginPayload({ status: "ok", data: { project: { name: "Demo" } } })).toEqual({
      project: { name: "Demo" },
    });

    expect(() =>
      unwrapPluginPayload({ status: "error", message: "No project selected" }),
    ).toThrow("No project selected");
  });

  it("describes missing graph files as an actionable project state", () => {
    expect(describeGraphLoadError(new Error("File not found"))).toContain(
      "has not generated a graph",
    );
    expect(describeGraphLoadError(new Error("Request failed with status code 404"))).toContain(
      "has not generated a graph",
    );
  });
});
