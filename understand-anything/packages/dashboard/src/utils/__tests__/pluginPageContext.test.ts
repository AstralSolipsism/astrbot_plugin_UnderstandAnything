import { describe, expect, it } from "vitest";

import {
  buildBridgeSdkUrl,
  isAstrBotPluginPageContext,
} from "../pluginPageContext";

const pluginContentPath = [
  "",
  "api",
  "plugin",
  "page",
  "content",
  "astrbot_plugin_UnderstandAnything",
  "dashboard",
  "",
].join("/");
const bridgeSdkPath = ["", "api", "plugin", "page", "bridge-sdk.js"].join("/");

describe("plugin page context detection", () => {
  it("treats AstrBot asset-token URLs as plugin pages even before bridge injection", () => {
    expect(
      isAstrBotPluginPageContext(
        {
          pathname: pluginContentPath,
          search: "?asset_token=signed-token",
        },
        undefined,
      ),
    ).toBe(true);
  });

  it("keeps standalone dashboard URLs in token-gated mode", () => {
    expect(
      isAstrBotPluginPageContext(
        {
          pathname: "/dashboard/",
          search: "",
        },
        undefined,
      ),
    ).toBe(false);
  });

  it("treats an injected bridge as plugin page context", () => {
    expect(
      isAstrBotPluginPageContext(
        {
          pathname: "/dashboard/",
          search: "",
        },
        { ready: async () => undefined },
      ),
    ).toBe(true);
  });

  it("builds a bridge SDK URL with page-scoped i18n and the current asset token", () => {
    expect(
      buildBridgeSdkUrl({
        pathname: pluginContentPath,
        search: "?asset_token=signed-token&project_id=p1",
      }),
    ).toBe(`${bridgeSdkPath}?i18n_scope=page&asset_token=signed-token`);
  });
});
