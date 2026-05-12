import { describe, expect, it } from "vitest";
import {
  describePluginRouteError,
  disabledComputerUseConfigs,
  describeGraphLoadError,
  errorMessage,
  hasProjectRef,
  isComputerUseReady,
  isPluginRouteMissingError,
  pluginGetOptional,
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

  it("formats plugin error objects without leaking object string output", () => {
    expect(errorMessage({ error: "File not found" })).toBe("File not found");
    expect(errorMessage({ status: "error", message: "Graph file not found" })).toBe(
      "Graph file not found",
    );
    expect(describeGraphLoadError({ error: "File not found" })).toContain(
      "has not generated a graph",
    );
  });

  it("treats disabled Computer Use Runtime as a blocking setup state", () => {
    expect(
      isComputerUseReady({
        id: "default",
        name: "default",
        is_default: true,
        runtime: "none",
        enabled: false,
        require_admin: true,
        sandbox_booter: "shipyard_neo",
        blocking_reason: "Computer Use Runtime is disabled.",
      }),
    ).toBe(false);
    expect(
      isComputerUseReady({
        id: "default",
        name: "default",
        is_default: true,
        runtime: "local",
        enabled: true,
        require_admin: true,
        sandbox_booter: "shipyard_neo",
        blocking_reason: "",
      }),
    ).toBe(true);
  });

  it("uses default Computer Use config for dashboard readiness and lists disabled configs", () => {
    const status = {
      id: "default",
      name: "default",
      is_default: true,
      runtime: "none",
      enabled: false,
      require_admin: true,
      sandbox_booter: "",
      blocking_reason: "disabled",
      default_config: {
        id: "default",
        name: "default",
        is_default: true,
        runtime: "none",
        enabled: false,
        require_admin: true,
        sandbox_booter: "",
        blocking_reason: "disabled",
      },
      configs: [
        {
          id: "default",
          name: "default",
          is_default: true,
          runtime: "none",
          enabled: false,
          require_admin: true,
          sandbox_booter: "",
          blocking_reason: "disabled",
        },
        {
          id: "chat-config",
          name: "Chat config",
          is_default: false,
          runtime: "local",
          enabled: true,
          require_admin: false,
          sandbox_booter: "",
          blocking_reason: "",
        },
      ],
    };

    expect(isComputerUseReady(status)).toBe(false);
    expect(disabledComputerUseConfigs(status).map((config) => config.id)).toEqual([
      "default",
    ]);
  });

  it("recognizes AstrBot plugin API route missing errors", () => {
    expect(isPluginRouteMissingError(new Error("未找到该路由"))).toBe(true);
    expect(isPluginRouteMissingError(new Error("route not found"))).toBe(true);
    expect(isPluginRouteMissingError(new Error("provider failed"))).toBe(false);
    expect(describePluginRouteError("status", new Error("未找到该路由"))).toContain(
      "Reload",
    );
  });

  it("treats optional plugin route missing as unavailable instead of fatal", async () => {
    const bridge = {
      ready: async () => undefined,
      apiGet: async () => {
        throw new Error("未找到该路由");
      },
    };

    await expect(pluginGetOptional(bridge, "subagents/status")).resolves.toBeNull();
  });
});
