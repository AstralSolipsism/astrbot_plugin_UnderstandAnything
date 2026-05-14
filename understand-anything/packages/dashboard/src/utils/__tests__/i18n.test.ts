import { describe, expect, it } from "vitest";

import {
  createDashboardTranslator,
  dashboardI18nKey,
  normalizeLocale,
  translateLocal
} from "../../i18n";
import type { AstrBotPluginPageBridge } from "../astrbotBridge";

describe("dashboard i18n", () => {
  it("normalizes AstrBot locale values", () => {
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeLocale("ru")).toBe("ru-RU");
    expect(normalizeLocale("en")).toBe("en-US");
  });

  it("uses nested AstrBot bridge i18n before local fallback", () => {
    let bridgeTCalls = 0;
    const bridge: AstrBotPluginPageBridge = {
      ready: async () => undefined,
      apiGet: async () => ({}),
      getLocale: () => "zh-CN",
      getI18n: () => ({
        "zh-CN": {
          pages: {
            dashboard: {
              ui: {
                common: {
                  refresh: "Bridge Refresh"
                }
              }
            }
          }
        }
      }),
      t: (key, fallback) => {
        bridgeTCalls += 1;
        return fallback ?? key;
      }
    };

    const t = createDashboardTranslator(bridge, "en-US");

    expect(t("common.refresh", "Refresh")).toBe("Bridge Refresh");
    expect(bridgeTCalls).toBe(0);
  });

  it("falls back to local locale messages when bridge key is missing", () => {
    const bridge: AstrBotPluginPageBridge = {
      ready: async () => undefined,
      apiGet: async () => ({}),
      getLocale: () => "zh-CN",
      t: (_key, fallback) => fallback ?? ""
    };

    const t = createDashboardTranslator(bridge, "en-US");

    expect(t("common.refresh", "Refresh")).toBe("刷新");
  });

  it("falls back to the provided string for unknown keys", () => {
    expect(translateLocal("ru-RU", "missing.key", "Fallback")).toBe("Fallback");
    expect(dashboardI18nKey("common.refresh")).toBe(
      "pages.dashboard.ui.common.refresh"
    );
  });

  it("describes the GitHub proxy empty option as automatic fallback mode", () => {
    expect(translateLocal("zh-CN", "workspace.githubProxyDirect", "")).toBe(
      "自动：先直连，失败后使用代理"
    );
    expect(translateLocal("en-US", "workspace.githubProxyDirect", "")).toBe(
      "Automatic: direct, then proxies"
    );
    expect(
      translateLocal("zh-CN", "workspace.githubProxyDescription", "")
    ).toContain("自动切换内置代理预设");
    expect(translateLocal("zh-CN", "workspace.githubProxyDirect", "")).not.toBe(
      "直连 GitHub"
    );
  });

  it("localizes Computer Use setup guidance without unsupported routes", () => {
    const guidance = [
      translateLocal("zh-CN", "workspace.computerUseDisabledTitle", ""),
      translateLocal("zh-CN", "workspace.computerUseDisabledDescription", ""),
      translateLocal("zh-CN", "workspace.computerUseRuntime", ""),
      translateLocal("zh-CN", "workspace.computerUseSetupPathLabel", ""),
      translateLocal("zh-CN", "workspace.computerUseSetupPath", ""),
      translateLocal("zh-CN", "workspace.computerUseSetupValueLabel", ""),
      translateLocal("zh-CN", "workspace.computerUseSetupValue", ""),
      translateLocal("zh-CN", "workspace.computerUseSetupApplyLabel", ""),
      translateLocal("zh-CN", "workspace.computerUseSetupApply", ""),
      translateLocal("zh-CN", "workspace.computerUsePartialDescription", "")
    ].join("\n");

    expect(guidance).toContain("配置");
    expect(guidance).toContain("使用电脑能力");
    expect(guidance).toContain("使用电脑能力-运行环境");
    expect(guidance).toContain("运行环境");
    expect(guidance).toContain("local");
    expect(guidance).not.toContain("Agent Computer Use");
    expect(guidance).not.toContain("AstrBot Computer Use");
    expect(guidance).not.toContain("#/config");
    expect(guidance).not.toContain("provider_settings.computer_use_runtime");
  });
});
