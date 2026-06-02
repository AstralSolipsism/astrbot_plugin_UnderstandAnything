import { validateGraph } from "@understand-anything/core/schema";

interface ValidateGraphRequest {
  type: "validate";
  requestId: number;
  text: string;
}

interface ValidateGraphResponse {
  type: "validated";
  requestId: number;
  success: boolean;
  data?: unknown;
  issues?: unknown;
  fatal?: string;
  rawKind?: unknown;
}

interface GraphValidationWorkerScope {
  onmessage: ((event: MessageEvent<ValidateGraphRequest>) => void) | null;
  postMessage: (message: ValidateGraphResponse) => void;
}

const ctx = self as unknown as GraphValidationWorkerScope;

ctx.onmessage = (event: MessageEvent<ValidateGraphRequest>) => {
  const message = event.data;
  if (message.type !== "validate") return;

  try {
    const raw = JSON.parse(message.text) as Record<string, unknown>;
    const result = validateGraph(raw);
    const response: ValidateGraphResponse = {
      type: "validated",
      requestId: message.requestId,
      success: Boolean(result.success && result.data),
      data: result.data,
      issues: result.issues,
      fatal: result.fatal,
      rawKind: raw.kind,
    };
    ctx.postMessage(response);
  } catch (error) {
    ctx.postMessage({
      type: "validated",
      requestId: message.requestId,
      success: false,
      fatal: error instanceof Error ? error.message : "JSON 解析失败",
    } satisfies ValidateGraphResponse);
  }
};

export {};
