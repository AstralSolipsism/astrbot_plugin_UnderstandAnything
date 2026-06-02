import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";

export type AssistantReferenceTarget =
  | { type: "node"; nodeId: string }
  | { type: "file"; path: string; nodeId: string }
  | { type: "code-range"; path: string; startLine: number; endLine: number; nodeId: string }
  | { type: "domain"; nodeId: string; nodeType: string; domainId: string | null };

function decodeReferenceValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validLineRange(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && Number.isInteger(value[0])
    && Number.isInteger(value[1])
    && value[0] > 0
    && value[1] >= value[0];
}

function findFileNode(graph: KnowledgeGraph | null, path: string): GraphNode | null {
  const nodes = graph?.nodes ?? [];
  return nodes.find((node) => node.filePath === path && node.type === "file")
    ?? nodes.find((node) => node.filePath === path)
    ?? null;
}

function findCodeRangeNode(
  graph: KnowledgeGraph | null,
  path: string,
  startLine: number,
): GraphNode | null {
  const nodes = (graph?.nodes ?? [])
    .flatMap((node) => {
      if (node.filePath !== path || !validLineRange(node.lineRange)) return [];
      if (node.lineRange[0] > startLine || node.lineRange[1] < startLine) return [];
      return [{ node, span: node.lineRange[1] - node.lineRange[0] }];
    })
    .sort((a, b) => a.span - b.span);
  return nodes[0]?.node ?? null;
}

function parseCodeRangeHref(href: string): { path: string; startLine: number; endLine: number } | null {
  const rest = href.slice("code-range:".length);
  const separator = rest.lastIndexOf(":");
  if (separator <= 0) return null;
  const path = decodeReferenceValue(rest.slice(0, separator));
  const range = rest.slice(separator + 1).match(/^(\d+)-(\d+)$/u);
  if (!range) return null;
  const startLine = Number(range[1]);
  const endLine = Number(range[2]);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine <= 0 || endLine < startLine) {
    return null;
  }
  return { path, startLine, endLine };
}

function parentDomainId(domainGraph: KnowledgeGraph, node: GraphNode): string | null {
  if (node.type === "domain") return node.id;
  if (node.type === "flow") {
    return domainGraph.edges.find((edge) => edge.type === "contains_flow" && edge.target === node.id)?.source ?? null;
  }
  if (node.type === "step") {
    const flowId = domainGraph.edges.find((edge) => edge.type === "flow_step" && edge.target === node.id)?.source;
    if (!flowId) return null;
    return domainGraph.edges.find((edge) => edge.type === "contains_flow" && edge.target === flowId)?.source ?? null;
  }
  return null;
}

export function resolveAssistantReferenceTarget(
  href: string,
  graph: KnowledgeGraph | null,
  domainGraph: KnowledgeGraph | null,
): AssistantReferenceTarget | null {
  if (href.startsWith("node:")) {
    const nodeId = decodeReferenceValue(href.slice("node:".length));
    if (!graph?.nodes.some((node) => node.id === nodeId)) return null;
    return { type: "node", nodeId };
  }

  if (href.startsWith("file:")) {
    const path = decodeReferenceValue(href.slice("file:".length));
    const node = findFileNode(graph, path);
    if (!node) return null;
    return { type: "file", path, nodeId: node.id };
  }

  if (href.startsWith("code-range:")) {
    const parsed = parseCodeRangeHref(href);
    if (!parsed) return null;
    const node = findCodeRangeNode(graph, parsed.path, parsed.startLine)
      ?? findCodeRangeNode(domainGraph, parsed.path, parsed.startLine)
      ?? findFileNode(graph, parsed.path);
    if (!node) return null;
    return {
      type: "code-range",
      path: parsed.path,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      nodeId: node.id,
    };
  }

  if (href.startsWith("domain:")) {
    const nodeId = decodeReferenceValue(href.slice("domain:".length));
    const node = domainGraph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || !domainGraph) return null;
    return {
      type: "domain",
      nodeId: node.id,
      nodeType: node.type,
      domainId: parentDomainId(domainGraph, node),
    };
  }

  return null;
}

export function isAssistantInternalHref(href: string | undefined): href is string {
  return Boolean(href)
    && (href!.startsWith("node:")
      || href!.startsWith("file:")
      || href!.startsWith("code-range:")
      || href!.startsWith("domain:"));
}
