import type {
  AssistantContextItem,
  DashboardAssistantMessage,
} from "../store";
import {
  type AstrBotPluginPageBridge,
  type ProjectRefParams,
  pluginGet,
  pluginPost,
} from "./astrbotBridge";

export interface WebChatSessionSummary {
  session_id: string;
  platform_id?: string;
  creator?: string;
  display_name?: string | null;
  is_group?: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WebChatHistoryRecord {
  id?: string | number;
  content?: {
    type?: string;
    message?: WebChatMessagePart[];
    [key: string]: unknown;
  };
  sender_id?: string;
  sender_name?: string;
  created_at?: string;
  updated_at?: string;
}

export interface WebChatSessionPayload {
  session: WebChatSessionSummary;
  history: WebChatHistoryRecord[];
  ua_context?: {
    project_ref?: ProjectRefParams;
    context_items?: AssistantContextItem[];
  } | null;
}

export interface WebChatSendRequest extends ProjectRefParams {
  session_id?: string;
  message: string;
  contextItems?: AssistantContextItem[];
  selected_provider?: string;
  selected_model?: string;
}

export interface WebChatSendStarted {
  request_id: string;
  message_id?: string;
  session_id: string;
  llm_checkpoint_id?: string;
}

export interface WebChatSseEvent {
  type?: string;
  data?: unknown;
  session_id?: string;
  message_id?: string;
  streaming?: boolean;
  chain_type?: string;
  [key: string]: unknown;
}

export type WebChatMessagePart = {
  type?: string;
  text?: string;
  think?: string;
  filename?: string;
  attachment_id?: string;
  tool_calls?: Array<Record<string, unknown>>;
  content?: unknown;
  [key: string]: unknown;
};

export function sessionDisplayName(session: WebChatSessionSummary): string {
  return session.display_name?.trim() || `WebChat ${session.session_id.slice(0, 8)}`;
}

export function selectDashboardWebChatSession(input: {
  sessions: WebChatSessionSummary[];
  preferredSessionId?: string | null;
  currentSessionId?: string | null;
  preserveCurrent?: boolean;
}): string | null {
  const preferredSessionId = input.preferredSessionId?.trim();
  if (preferredSessionId) return preferredSessionId;

  const currentSessionId = input.currentSessionId?.trim();
  if (
    input.preserveCurrent &&
    currentSessionId &&
    input.sessions.some((session) => session.session_id === currentSessionId)
  ) {
    return currentSessionId;
  }

  return null;
}

export async function listWebChatSessions(
  bridge: AstrBotPluginPageBridge,
): Promise<{ sessions: WebChatSessionSummary[]; total?: number }> {
  return pluginGet(bridge, "webchat/sessions");
}

export async function createWebChatSession(
  bridge: AstrBotPluginPageBridge,
  input: {
    display_name?: string;
    projectParams?: ProjectRefParams;
    contextItems?: AssistantContextItem[];
  },
): Promise<WebChatSessionSummary> {
  return pluginPost(bridge, "webchat/sessions", {
    ...(input.projectParams || {}),
    display_name: input.display_name,
    contextItems: input.contextItems || [],
  });
}

export async function getWebChatSession(
  bridge: AstrBotPluginPageBridge,
  sessionId: string,
): Promise<WebChatSessionPayload> {
  return pluginGet(bridge, `webchat/sessions/${encodeURIComponent(sessionId)}`);
}

export async function renameWebChatSession(
  bridge: AstrBotPluginPageBridge,
  sessionId: string,
  displayName: string,
): Promise<WebChatSessionSummary> {
  return pluginPost(
    bridge,
    `webchat/sessions/${encodeURIComponent(sessionId)}/rename`,
    { display_name: displayName },
  );
}

export async function startWebChatSend(
  bridge: AstrBotPluginPageBridge,
  request: WebChatSendRequest,
): Promise<WebChatSendStarted> {
  return pluginPost(bridge, "webchat/send", { ...request });
}

export async function stopWebChatSession(
  bridge: AstrBotPluginPageBridge,
  sessionId: string,
): Promise<{ stopped_count: number }> {
  return pluginPost(bridge, "webchat/stop", { session_id: sessionId });
}

export async function cancelWebChatSend(
  bridge: AstrBotPluginPageBridge,
  requestId: string,
  sessionId?: string | null,
): Promise<{ cancelled: boolean; session_id?: string; stopped_count?: number }> {
  return pluginPost(bridge, "webchat/send-cancel", {
    request_id: requestId,
    ...(sessionId ? { session_id: sessionId } : {}),
  });
}

export async function subscribeWebChatSendEvents(
  bridge: AstrBotPluginPageBridge,
  requestId: string,
  handlers: {
    onMessage: (event: WebChatSseEvent) => void;
    onError?: () => void;
    onOpen?: () => void;
  },
): Promise<string> {
  if (!bridge.subscribeSSE) {
    throw new Error("AstrBot Plugin Page SSE bridge is unavailable.");
  }
  await bridge.ready();
  return bridge.subscribeSSE(
    "webchat/send-events",
    {
      onOpen: handlers.onOpen,
      onError: handlers.onError,
      onMessage: (event) => {
        if (event.parsed && typeof event.parsed === "object") {
          handlers.onMessage(event.parsed as WebChatSseEvent);
        }
      },
    },
    { request_id: requestId },
  );
}

export function webChatHistoryToDashboardMessages(
  history: WebChatHistoryRecord[],
): DashboardAssistantMessage[] {
  return history
    .map((record, index) => {
      const content = record.content || {};
      const role = content.type === "bot"
        ? "assistant"
        : content.type === "user"
          ? "user"
          : "system";
      const parts = webChatPartsToDashboardParts(content.message || []);
      const agentStats = content.agent_stats;
      if (agentStats && typeof agentStats === "object") {
        parts.push({ type: "agent-stats", stats: agentStats });
      }
      return {
        id: String(record.id ?? `history-${index}`),
        role,
        parts,
      } satisfies DashboardAssistantMessage;
    })
    .filter((message) => message.parts.length > 0);
}

export function textFromWebChatParts(
  parts: WebChatMessagePart[],
): string {
  return parts
    .map((part) => (part.type === "plain" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

export function webChatPartsToDashboardParts(
  parts: WebChatMessagePart[],
): DashboardAssistantMessage["parts"] {
  const mapped: DashboardAssistantMessage["parts"] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "plain") {
      const text = typeof part.text === "string" ? part.text : "";
      if (text) mapped.push({ type: "text", text });
      continue;
    }
    if (part.type === "think") {
      const text = typeof part.think === "string"
        ? part.think
        : typeof part.text === "string"
          ? part.text
          : "";
      if (text) mapped.push({ type: "reasoning", text });
      continue;
    }
    if (part.type === "tool_call") {
      const toolCalls = Array.isArray(part.tool_calls) ? part.tool_calls : [part];
      for (const toolCall of toolCalls) {
        mapped.push({
          type: "tool-call",
          label: toolLabel(toolCall),
          payload: toolCall,
        });
      }
      continue;
    }
    if (part.type === "tool_call_result") {
      mapped.push({
        type: "tool-result",
        label: toolResultLabel(part),
        payload: stripPartType(part),
      });
      continue;
    }
    if (["image", "record", "file", "video"].includes(String(part.type))) {
      mapped.push({
        type: "attachment",
        attachmentType: part.type,
        filename: typeof part.filename === "string" ? part.filename : "",
        attachmentId: typeof part.attachment_id === "string" ? part.attachment_id : "",
      });
      continue;
    }
    const label = typeof part.type === "string" && part.type ? part.type : "webchat-part";
    mapped.push({ type: "webchat-part", label, payload: part });
  }
  return mapped;
}

function stripPartType(part: WebChatMessagePart): Record<string, unknown> {
  const { type: _type, ...rest } = part;
  return rest;
}

function toolLabel(toolCall: Record<string, unknown>): string {
  const name = toolCall.name;
  const id = toolCall.id;
  if (typeof name === "string" && name.trim()) return name;
  if (typeof id === "string" && id.trim()) return id;
  return "Tool call";
}

function toolResultLabel(part: WebChatMessagePart): string {
  if (typeof part.content === "string" && part.content.trim()) return part.content;
  if (typeof part.tool_call_id === "string" && part.tool_call_id.trim()) {
    return part.tool_call_id;
  }
  return "Tool result";
}
