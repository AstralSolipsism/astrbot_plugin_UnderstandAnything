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
});
