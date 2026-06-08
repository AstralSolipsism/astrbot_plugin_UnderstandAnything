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

  it("localizes analysis option help text", () => {
    expect(translateLocal("zh-CN", "workspace.fullAnalysisHelp", "")).toContain(
      "完整图谱"
    );
    expect(translateLocal("zh-CN", "workspace.autoUpdateHelp", "")).toContain(
      "轮询间隔"
    );
    expect(translateLocal("en-US", "workspace.fullAnalysisHelp", "")).toContain(
      "rebuild the whole graph"
    );
  });

  it("localizes update and full reanalysis as separate project actions", () => {
    expect(translateLocal("zh-CN", "workspace.updateProjectGraph", "")).toBe(
      "更新图谱"
    );
    expect(translateLocal("zh-CN", "workspace.fullReanalysis", "")).toBe(
      "完整重新分析"
    );
    expect(translateLocal("en-US", "workspace.updateProjectGraph", "")).toBe(
      "Update graph"
    );
    expect(translateLocal("en-US", "workspace.fullReanalysis", "")).toBe(
      "Full reanalysis"
    );
  });

  it("uses soft wording for job refresh degradation", () => {
    expect(translateLocal("zh-CN", "workspace.jobEventInterrupted", "")).not.toContain(
      "中断"
    );
    expect(translateLocal("zh-CN", "workspace.jobRefreshDelayed", "")).toContain(
      "进度刷新"
    );
  });

  it("localizes analysis tracking and job conversation labels", () => {
    expect(translateLocal("zh-CN", "workspace.analysisTrackingDescription", "")).toContain(
      "任务过程",
    );
    expect(translateLocal("zh-CN", "workspace.jobConversationTitle", "")).toBe(
      "任务对话流",
    );
    expect(translateLocal("zh-CN", "workspace.jobStatusWaitingConfirmation", "")).toBe(
      "等待确认",
    );
    expect(translateLocal("en-US", "workspace.jobObservationCommand", "")).toBe(
      "Command",
    );
    expect(translateLocal("ru-RU", "workspace.analysisTracking", "")).toBe(
      "Отслеживание анализа",
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

  it("localizes AssistantWorkbench WebChat labels from local messages", () => {
    expect(translateLocal("zh-CN", "assistant.modeChat", "")).toBe("问答");
    expect(translateLocal("en-US", "assistant.modeChat", "")).toBe("Chat");
    expect(translateLocal("zh-CN", "assistant.sseUnavailable", "")).toContain(
      "SSE bridge 不可用"
    );
    expect(translateLocal("en-US", "assistant.sseUnavailable", "")).toContain(
      "SSE bridge is unavailable"
    );
    expect(translateLocal("zh-CN", "assistant.contextCount", "", { count: 2 })).toBe(
      "2 个上下文已加入"
    );
    expect(translateLocal("en-US", "assistant.contextCount", "", { count: 2 })).toBe(
      "2 context items added"
    );
  });

  it("localizes workspace action buttons and compact state labels", () => {
    expect(translateLocal("zh-CN", "workspace.addProject", "")).toBe("添加项目");
    expect(translateLocal("en-US", "workspace.addProject", "")).toBe("Add project");
    expect(translateLocal("zh-CN", "common.default", "")).toBe("默认");
    expect(translateLocal("zh-CN", "common.none", "")).toBe("无");
  });
});
