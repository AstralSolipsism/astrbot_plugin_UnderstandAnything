import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, normalize, resolve, sep } from "node:path";
import {
  buildAssistantPrompt,
  buildDiffContext,
  buildDiffOverlay,
  buildOnboardingGuide,
  type AssistantContextItem,
  type AssistantMode,
  type AssistantPromptMessage,
  type SourceSnippet,
} from "@understand-anything/assistant";
import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";

export interface AssistantContextBundleActionPayload {
  projectRoot: string;
  graphRoot: string;
  mode?: string;
  messages?: unknown;
  items?: unknown;
  contextItems?: unknown;
  changedFiles?: unknown;
  gitCommitHash?: string;
  graphHash?: string;
}

export interface AssistantContextBundleActionResult {
  ok: boolean;
  artifacts: string[];
  observations: unknown[];
  warnings: string[];
  prompt: string;
  context: {
    mode: AssistantMode;
    items: AssistantContextItem[];
    sourceSnippets: SourceSnippet[];
    graphSummary: {
      project: KnowledgeGraph["project"];
      nodeCount: number;
      edgeCount: number;
      layerCount: number;
      domainNodeCount: number;
      domainEdgeCount: number;
    };
    diffOverlay?: ReturnType<typeof buildDiffOverlay>;
    onboardingDraft?: string;
  };
}

interface SanitizedContext {
  items: AssistantContextItem[];
  sourceSnippets: SourceSnippet[];
  warnings: string[];
}

const MAX_CONTEXT_ITEMS = 40;
const MAX_SNIPPET_LINES = 240;
const MAX_SNIPPET_CHARS = 20_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function readOptionalGraph(graphRoot: string, fileName: string): KnowledgeGraph | null {
  const path = resolve(graphRoot, fileName);
  if (!existsSync(path)) return null;
  return readJsonFile<KnowledgeGraph>(path);
}

function coerceMode(value: unknown): AssistantMode {
  if (value === "explain" || value === "diff" || value === "onboarding") return value;
  if (value === "onboard") return "onboarding";
  return "chat";
}

function coerceMessages(value: unknown): AssistantPromptMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).flatMap((item): AssistantPromptMessage[] => {
    const record = asRecord(item);
    if (!record) return [];
    const role = record.role === "assistant" ? "assistant" : "user";
    const content = typeof record.content === "string" ? record.content.trim() : "";
    return content ? [{ role, content }] : [];
  });
}

function cleanContextPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (text.includes("\0") || text.includes("\\")) return null;
  if (/^[A-Za-z]:[\\/]/u.test(text) || text.startsWith("/")) return null;
  const normalized = normalize(text);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized.split(sep).join("/");
}

function graphFileSet(graph: KnowledgeGraph | null | undefined): Set<string> {
  const files = new Set<string>();
  for (const node of graph?.nodes ?? []) {
    if (node.filePath) files.add(node.filePath);
  }
  return files;
}

function sourceInventoryFileSet(graphRoot: string): Set<string> {
  const files = new Set<string>();
  const path = resolve(graphRoot, "source-inventory.json");
  if (!existsSync(path)) return files;
  try {
    const inventory = readJsonFile<{ entries?: unknown }>(path);
    if (!Array.isArray(inventory.entries)) return files;
    for (const entry of inventory.entries) {
      const record = asRecord(entry);
      if (record?.kind !== "file" && record?.type !== "file") continue;
      const normalized = cleanContextPath(record.path);
      if (normalized) files.add(normalized);
    }
  } catch {
    return files;
  }
  return files;
}

function graphNodeById(
  graph: KnowledgeGraph | null | undefined,
  nodeId: string | undefined,
): GraphNode | undefined {
  if (!graph || !nodeId) return undefined;
  return graph.nodes.find((node) => node.id === nodeId);
}

function graphNodeByFile(
  graph: KnowledgeGraph | null | undefined,
  path: string,
): GraphNode | undefined {
  return graph?.nodes.find((node) => node.filePath === path && node.type === "file")
    ?? graph?.nodes.find((node) => node.filePath === path);
}

function resolvePathContext(
  item: Record<string, unknown>,
  path: string,
  graph: KnowledgeGraph,
  domainGraph: KnowledgeGraph | null,
  domainNodeIds: Set<string>,
): { graphKind?: "knowledge" | "domain"; nodeId?: string } {
  const rawNodeId = typeof item.nodeId === "string" ? item.nodeId : undefined;
  const requestedDomainNode =
    item.graphKind === "domain" && rawNodeId && domainNodeIds.has(rawNodeId)
      ? graphNodeById(domainGraph, rawNodeId)
      : undefined;
  const domainNode = requestedDomainNode ?? graphNodeByFile(domainGraph, path);
  const knowledgeNode = graphNodeByFile(graph, path);

  if (item.graphKind === "domain") {
    return {
      graphKind: "domain",
      nodeId: requestedDomainNode?.id ?? domainNode?.id,
    };
  }
  if (knowledgeNode) return { graphKind: "knowledge", nodeId: knowledgeNode.id };
  if (domainNode) return { graphKind: "domain", nodeId: domainNode.id };
  return {};
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

function detectLanguage(path: string): string {
  const extension = extname(path).toLowerCase().slice(1);
  return {
    js: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    py: "python",
    java: "java",
    go: "go",
    rs: "rust",
    rb: "ruby",
    php: "php",
    cs: "csharp",
    cpp: "cpp",
    cc: "cpp",
    c: "c",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
  }[extension] ?? "text";
}

function readSnippet(
  projectRoot: string,
  item: AssistantContextItem,
  warnings: string[],
): SourceSnippet | null {
  if (item.type !== "file" && item.type !== "code-range") return null;
  const absolutePath = resolve(projectRoot, item.path);
  if (!isInside(projectRoot, absolutePath)) {
    warnings.push("Rejected context item that resolves outside the project root.");
    return null;
  }
  if (!existsSync(absolutePath)) {
    warnings.push(`Context source file is missing: ${item.path}`);
    return null;
  }
  const raw = readFileSync(absolutePath, "utf-8");
  const lines = raw.split(/\r?\n/u);
  const startLine = item.type === "code-range" ? Math.max(1, item.startLine) : 1;
  const requestedEnd =
    item.type === "code-range" ? Math.max(startLine, item.endLine) : lines.length;
  const endLine = Math.min(lines.length, startLine + MAX_SNIPPET_LINES - 1, requestedEnd);
  const contentLines = lines.slice(startLine - 1, endLine);
  let content = contentLines.join("\n");
  let truncated = requestedEnd > endLine;
  if (content.length > MAX_SNIPPET_CHARS) {
    content = content.slice(0, MAX_SNIPPET_CHARS);
    truncated = true;
  }
  return {
    path: item.path,
    language: detectLanguage(item.path),
    content,
    startLine,
    endLine,
    truncated,
  };
}

function sanitizeContextItems(
  options: {
    projectRoot: string;
    graphRoot: string;
    graph: KnowledgeGraph;
    domainGraph: KnowledgeGraph | null;
    rawItems: unknown;
  },
): SanitizedContext {
  const rawItems = Array.isArray(options.rawItems) ? options.rawItems : [];
  const knowledgeNodeIds = new Set(options.graph.nodes.map((node) => node.id));
  const domainNodeIds = new Set((options.domainGraph?.nodes ?? []).map((node) => node.id));
  const layerIds = new Set(options.graph.layers.map((layer) => layer.id));
  const allowedFiles = new Set([
    ...graphFileSet(options.graph),
    ...graphFileSet(options.domainGraph),
    ...sourceInventoryFileSet(options.graphRoot),
  ]);
  const seen = new Set<string>();
  const items: AssistantContextItem[] = [];
  const warnings: string[] = [];

  const push = (key: string, item: AssistantContextItem) => {
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const raw of rawItems.slice(0, MAX_CONTEXT_ITEMS)) {
    const item = asRecord(raw);
    if (!item || typeof item.type !== "string") {
      warnings.push("Rejected malformed context item.");
      continue;
    }
    const label = typeof item.label === "string" ? item.label.slice(0, 160) : "";
    if (
      item.type === "node" &&
      typeof item.nodeId === "string" &&
      (knowledgeNodeIds.has(item.nodeId) || domainNodeIds.has(item.nodeId))
    ) {
      const graphKind =
        domainNodeIds.has(item.nodeId) && item.graphKind === "domain"
          ? "domain"
          : knowledgeNodeIds.has(item.nodeId)
            ? "knowledge"
            : "domain";
      const sourceGraph = graphKind === "domain" ? options.domainGraph : options.graph;
      const node = sourceGraph?.nodes.find((candidate) => candidate.id === item.nodeId);
      push(`node:${graphKind}:${item.nodeId}`, {
        type: "node",
        nodeId: item.nodeId,
        label: label || node?.name || item.nodeId,
        filePath: node?.filePath,
        graphKind,
      });
      continue;
    }
    if ((item.type === "file" || item.type === "diff-file") && typeof item.path === "string") {
      const normalizedPath = cleanContextPath(item.path);
      if (!normalizedPath) {
        warnings.push("Rejected context item with an unsafe path.");
        continue;
      }
      if (item.type === "file" && !allowedFiles.has(normalizedPath)) {
        warnings.push(`Rejected file context not present in graph or source inventory: ${normalizedPath}`);
        continue;
      }
      const context = resolvePathContext(item, normalizedPath, options.graph, options.domainGraph, domainNodeIds);
      if (item.type === "file") {
        push(`file:${context.graphKind ?? "inventory"}:${normalizedPath}`, {
          type: "file",
          path: normalizedPath,
          label: label || normalizedPath,
          nodeId: context.nodeId,
          graphKind: context.graphKind,
        });
      } else {
        const status =
          item.status === "added" ||
          item.status === "modified" ||
          item.status === "deleted" ||
          item.status === "renamed"
            ? item.status
            : undefined;
        push(`diff-file:${normalizedPath}`, {
          type: "diff-file",
          path: normalizedPath,
          status,
          label: label || normalizedPath,
          nodeId: context.nodeId,
          graphKind: context.graphKind,
        });
      }
      continue;
    }
    if (item.type === "code-range" && typeof item.path === "string") {
      const normalizedPath = cleanContextPath(item.path);
      const startLine = Number(item.startLine);
      const endLine = Number(item.endLine);
      if (
        !normalizedPath ||
        !allowedFiles.has(normalizedPath) ||
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine)
      ) {
        warnings.push("Rejected unsafe or invalid code-range context item.");
        continue;
      }
      const start = Math.max(1, startLine);
      const end = Math.min(Math.max(start, endLine), start + MAX_SNIPPET_LINES - 1);
      const context = resolvePathContext(item, normalizedPath, options.graph, options.domainGraph, domainNodeIds);
      push(`code-range:${context.graphKind ?? "inventory"}:${normalizedPath}:${start}-${end}`, {
        type: "code-range",
        path: normalizedPath,
        startLine: start,
        endLine: end,
        label: label || `${normalizedPath}:${start}-${end}`,
        nodeId: context.nodeId,
        graphKind: context.graphKind,
      });
      continue;
    }
    if (item.type === "layer" && typeof item.layerId === "string" && layerIds.has(item.layerId)) {
      const layer = options.graph.layers.find((candidate) => candidate.id === item.layerId);
      push(`layer:${item.layerId}`, {
        type: "layer",
        layerId: item.layerId,
        label: label || layer?.name || item.layerId,
      });
      continue;
    }
    warnings.push("Rejected unsupported or unresolved context item.");
  }

  const sourceSnippets = items.flatMap((item): SourceSnippet[] => {
    const snippet = readSnippet(options.projectRoot, item, warnings);
    return snippet ? [snippet] : [];
  });

  return { items, sourceSnippets, warnings };
}

function sanitizeChangedFiles(rawFiles: unknown, warnings: string[]): string[] {
  if (!Array.isArray(rawFiles)) return [];
  const files: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawFiles.slice(0, 200)) {
    const path = cleanContextPath(raw);
    if (!path) {
      warnings.push("Rejected changed file with an unsafe path.");
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

function forbiddenPathPatterns(projectRoot: string, graphRoot: string): RegExp[] {
  const roots = [projectRoot, graphRoot]
    .map((value) => resolve(value).replace(/\\/g, "/"))
    .filter(Boolean)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return [
    /\/data\/projects(?:\/|$)/u,
    /\/data\/repo-sources(?:\/|$)/u,
    /\b[A-Za-z]:\//u,
    ...roots.map((root) => new RegExp(root, "u")),
  ];
}

function assertNoForbiddenAbsolutePaths(
  label: string,
  value: unknown,
  projectRoot: string,
  graphRoot: string,
): void {
  const text = JSON.stringify(value, null, 2)?.replace(/\\/g, "/") ?? "";
  if (forbiddenPathPatterns(projectRoot, graphRoot).some((pattern) => pattern.test(text))) {
    throw new Error(`${label} contains a forbidden absolute project storage path.`);
  }
}

function graphSummary(graph: KnowledgeGraph, domainGraph: KnowledgeGraph | null) {
  return {
    project: graph.project,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    layerCount: graph.layers.length,
    domainNodeCount: domainGraph?.nodes.length ?? 0,
    domainEdgeCount: domainGraph?.edges.length ?? 0,
  };
}

export function buildAssistantContextBundle(
  payload: AssistantContextBundleActionPayload,
): AssistantContextBundleActionResult {
  const projectRoot = resolve(String(payload.projectRoot || ""));
  const graphRoot = resolve(String(payload.graphRoot || ""));
  if (!projectRoot || !graphRoot) {
    throw new Error("assistant_context_bundle requires projectRoot and graphRoot.");
  }
  const graph = readJsonFile<KnowledgeGraph>(resolve(graphRoot, "knowledge-graph.json"));
  const domainGraph = readOptionalGraph(graphRoot, "domain-graph.json");
  const mode = coerceMode(payload.mode);
  const messages = coerceMessages(payload.messages);
  const rawItems = payload.contextItems ?? payload.items;
  const sanitized = sanitizeContextItems({
    projectRoot,
    graphRoot,
    graph,
    domainGraph,
    rawItems,
  });
  const warnings = [...sanitized.warnings];
  const changedFiles = sanitizeChangedFiles(payload.changedFiles, warnings);
  const diffContext = mode === "diff" ? buildDiffContext(graph, changedFiles) : null;
  const onboardingDraft = mode === "onboarding" ? buildOnboardingGuide(graph) : null;
  const prompt = buildAssistantPrompt({
    mode,
    graph,
    domainGraph,
    messages,
    contextItems: sanitized.items,
    sourceSnippets: sanitized.sourceSnippets,
    diffContext,
    onboardingDraft,
    gitCommitHash: payload.gitCommitHash,
    graphHash: payload.graphHash,
  });
  const context = {
    mode,
    items: sanitized.items,
    sourceSnippets: sanitized.sourceSnippets,
    graphSummary: graphSummary(graph, domainGraph),
    ...(diffContext ? { diffOverlay: buildDiffOverlay(diffContext) } : {}),
    ...(onboardingDraft ? { onboardingDraft } : {}),
  };
  assertNoForbiddenAbsolutePaths("Assistant prompt", prompt, projectRoot, graphRoot);
  assertNoForbiddenAbsolutePaths("Assistant context", context, projectRoot, graphRoot);
  return {
    ok: true,
    artifacts: [],
    observations: [],
    warnings,
    prompt,
    context,
  };
}
