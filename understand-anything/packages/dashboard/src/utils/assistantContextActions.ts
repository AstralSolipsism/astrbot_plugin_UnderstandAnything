import type { AssistantContextItem, AssistantGraphKind } from "../store";

export function buildFileAssistantContextItem({
  path,
  nodeId,
  graphKind,
  label = path,
}: {
  path: string;
  nodeId?: string;
  graphKind?: AssistantGraphKind;
  label?: string;
}): AssistantContextItem {
  return {
    type: "file",
    path,
    label,
    nodeId,
    graphKind,
  };
}

export function buildCodeLineAssistantContextItem({
  path,
  lineNumber,
  nodeId,
  graphKind,
}: {
  path: string;
  lineNumber: number;
  nodeId?: string;
  graphKind?: AssistantGraphKind;
}): AssistantContextItem {
  return {
    type: "code-range",
    path,
    startLine: lineNumber,
    endLine: lineNumber,
    label: `${path}:${lineNumber}`,
    nodeId,
    graphKind,
  };
}
