import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AstrBotPluginPageBridge } from "../astrbotBridge";
import {
  cancelWebChatSend,
  createWebChatSession,
  getWebChatSession,
  listWebChatSessions,
  renameWebChatSession,
  sessionDisplayName,
  startWebChatSend,
  stopWebChatSession,
  subscribeWebChatSendEvents,
  webChatHistoryToDashboardMessages,
} from "../webchatClient";

function fakeBridge() {
  const calls: Array<{ kind: string; endpoint: string; payload?: unknown }> = [];
  const bridge: AstrBotPluginPageBridge = {
    ready: async () => undefined,
    apiGet: async (endpoint, params) => {
      calls.push({ kind: "get", endpoint, payload: params });
      if (endpoint === "webchat/sessions") {
        return { status: "ok", data: { sessions: [{ session_id: "s1" }], total: 1 } };
      }
      return {
        status: "ok",
        data: {
          session: { session_id: "s1", display_name: "Demo" },
          history: [],
        },
      };
    },
    apiPost: async (endpoint, body) => {
      calls.push({ kind: "post", endpoint, payload: body });
      return { status: "ok", data: { session_id: "s1", request_id: "m1", stopped_count: 1 } };
    },
    subscribeSSE: async (endpoint, handlers, params) => {
      calls.push({ kind: "sse", endpoint, payload: params });
      handlers.onMessage?.({ parsed: { type: "plain", data: "ok" }, raw: "" });
      return "sub-1";
    },
  };
  return { bridge, calls };
}

describe("webchat client helpers", () => {
  it("uses only plugin bridge endpoints for first-phase WebChat calls", async () => {
    const { bridge, calls } = fakeBridge();

    await listWebChatSessions(bridge);
    await createWebChatSession(bridge, {
      display_name: "UA Demo",
      projectParams: { project_id: "p1" },
      contextItems: [{ type: "node", nodeId: "root", label: "Root" }],
    });
    await getWebChatSession(bridge, "s1");
    await renameWebChatSession(bridge, "s1", "Renamed");
    await startWebChatSend(bridge, {
      session_id: "s1",
      message: "解释项目",
      project_id: "p1",
      contextItems: [{ type: "file", path: "src/app.ts", label: "app.ts" }],
    });
    await cancelWebChatSend(bridge, "m1", "s1");
    await stopWebChatSession(bridge, "s1");

    expect(calls.map((call) => call.endpoint)).toEqual([
      "webchat/sessions",
      "webchat/sessions",
      "webchat/sessions/s1",
      "webchat/sessions/s1/rename",
      "webchat/send",
      "webchat/send-cancel",
      "webchat/stop",
    ]);
    expect(JSON.stringify(calls)).not.toContain(["", "api", "chat"].join("/"));
    expect(calls[1]?.payload).toMatchObject({
      display_name: "UA Demo",
      project_id: "p1",
      contextItems: [{ type: "node", nodeId: "root", label: "Root" }],
    });
    expect(calls[4]?.payload).toMatchObject({
      session_id: "s1",
      message: "解释项目",
      project_id: "p1",
      contextItems: [{ type: "file", path: "src/app.ts", label: "app.ts" }],
    });
    expect(calls[5]?.payload).toEqual({
      request_id: "m1",
      session_id: "s1",
    });
  });

  it("subscribes send events through plugin SSE bridge", async () => {
    const { bridge, calls } = fakeBridge();
    const events: unknown[] = [];

    const subscriptionId = await subscribeWebChatSendEvents(bridge, "m1", {
      onMessage: (event) => events.push(event),
    });

    expect(subscriptionId).toBe("sub-1");
    expect(calls.at(-1)).toEqual({
      kind: "sse",
      endpoint: "webchat/send-events",
      payload: { request_id: "m1" },
    });
    expect(events).toEqual([{ type: "plain", data: "ok" }]);
  });

  it("maps native WebChat history into dashboard messages", () => {
    const messages = webChatHistoryToDashboardMessages([
      {
        id: 1,
        content: { type: "user", message: [{ type: "plain", text: "你好" }] },
      },
      {
        id: 2,
        content: {
          type: "bot",
          message: [
            { type: "plain", text: "项目说明" },
            { type: "think", think: "推理过程" },
            { type: "tool_call", tool_calls: [{ name: "ua_status" }] },
            { type: "tool_call_result", content: "ready" },
            { type: "image", filename: "graph.png", attachment_id: "att-1" },
            { type: "file", filename: "report.md", attachment_id: "att-2" },
          ],
          agent_stats: { tokens: 12 },
        },
      },
    ]);

    expect(messages).toEqual([
      { id: "1", role: "user", parts: [{ type: "text", text: "你好" }] },
      {
        id: "2",
        role: "assistant",
        parts: [
          { type: "text", text: "项目说明" },
          { type: "reasoning", text: "推理过程" },
          { type: "tool-call", label: "ua_status", payload: { name: "ua_status" } },
          { type: "tool-result", label: "ready", payload: { content: "ready" } },
          { type: "attachment", attachmentType: "image", filename: "graph.png", attachmentId: "att-1" },
          { type: "attachment", attachmentType: "file", filename: "report.md", attachmentId: "att-2" },
          { type: "agent-stats", stats: { tokens: 12 } },
        ],
      },
    ]);
  });

  it("uses display names before generated session labels", () => {
    expect(sessionDisplayName({ session_id: "abcdef123", display_name: "Demo" })).toBe("Demo");
    expect(sessionDisplayName({ session_id: "abcdef123" })).toBe("WebChat abcdef12");
  });

  it("drives AssistantWorkbench through WebChat sessions instead of private assistant endpoints", () => {
    const source = readFileSync(
      resolve(__dirname, "../../components/AssistantWorkbench.tsx"),
      "utf-8",
    );

    expect(source).toContain("listWebChatSessions");
    expect(source).toContain("createWebChatSession");
    expect(source).toContain("getWebChatSession");
    expect(source).toContain("renameWebChatSession");
    expect(source).toContain("startWebChatSend");
    expect(source).toContain("cancelWebChatSend");
    expect(source).toContain("subscribeWebChatSendEvents");
    expect(source).toContain("stopWebChatSession");
    expect(source).toContain("useI18n");
    expect(source).toContain("bridge.subscribeSSE");
    expect(source).not.toContain('endpoint: "chat"');
    expect(source).not.toContain('endpoint: "explain"');
    expect(source).not.toContain('endpoint: "diff"');
    expect(source).not.toContain('endpoint: "onboard"');
    expect(source).not.toContain("AssistantResponse");
  });
});
