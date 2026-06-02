import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";

export type AssistantReferenceKind = "node" | "file" | "domain";

export interface AssistantReferenceEntry {
  text: string;
  href: string;
  kind: AssistantReferenceKind;
  priority: number;
}

export interface AssistantReferenceIndex {
  entries: AssistantReferenceEntry[];
}

export interface AssistantReferenceMatch {
  start: number;
  end: number;
  text: string;
  href: string;
}

interface CountedTarget {
  count: number;
  href: string;
  kind: AssistantReferenceKind;
  priority: number;
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.includes("\0") || path.startsWith("/")) return null;
  if (path === "." || path === ".." || path.startsWith("../") || path.includes("/../")) return null;
  return path;
}

function sourceFilePaths(node: GraphNode): string[] {
  const sourcePaths = node.domainMeta?.sourceFilePaths;
  if (!Array.isArray(sourcePaths)) return [];
  return sourcePaths
    .map((path) => normalizePath(path))
    .filter((path): path is string => Boolean(path));
}

function hasCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function canAutoLinkText(value: string, kind: AssistantReferenceKind): boolean {
  const text = value.trim();
  if (!text) return false;
  if (kind === "file") return text.length >= 3 && text.includes(".");
  if (hasCjk(text)) return text.length >= 2;
  return text.length >= 3;
}

function addCountedTarget(
  targets: Map<string, CountedTarget>,
  text: string | undefined,
  href: string,
  kind: AssistantReferenceKind,
  priority: number,
): void {
  if (!text || !canAutoLinkText(text, kind)) return;
  const existing = targets.get(text);
  if (existing) {
    existing.count += 1;
    return;
  }
  targets.set(text, { count: 1, href, kind, priority });
}

function addUniqueEntry(entries: AssistantReferenceEntry[], seen: Set<string>, entry: AssistantReferenceEntry): void {
  const key = `${entry.text}\0${entry.href}`;
  if (seen.has(key)) return;
  seen.add(key);
  entries.push(entry);
}

function nodeHref(nodeId: string): string {
  return `node:${encodeURIComponent(nodeId)}`;
}

function domainHref(nodeId: string): string {
  return `domain:${encodeURIComponent(nodeId)}`;
}

function fileHref(path: string): string {
  return `file:${encodeURIComponent(path)}`;
}

function codeRangeHref(path: string, startLine: number, endLine: number): string {
  return `code-range:${encodeURIComponent(path)}:${startLine}-${endLine}`;
}

export function buildAssistantReferenceIndex(
  graph: KnowledgeGraph | null,
  domainGraph: KnowledgeGraph | null,
): AssistantReferenceIndex {
  const entries: AssistantReferenceEntry[] = [];
  const seenEntries = new Set<string>();
  const counted = new Map<string, CountedTarget>();

  for (const node of graph?.nodes ?? []) {
    const filePath = normalizePath(node.filePath);
    if (filePath) {
      addUniqueEntry(entries, seenEntries, {
        text: filePath,
        href: fileHref(filePath),
        kind: "file",
        priority: 0,
      });
    }
    addCountedTarget(counted, node.id, nodeHref(node.id), "node", 2);
    addCountedTarget(counted, node.name, nodeHref(node.id), "node", 2);
  }

  for (const node of domainGraph?.nodes ?? []) {
    const filePath = normalizePath(node.filePath);
    if (filePath) {
      addUniqueEntry(entries, seenEntries, {
        text: filePath,
        href: fileHref(filePath),
        kind: "file",
        priority: 0,
      });
    }
    for (const sourcePath of sourceFilePaths(node)) {
      addUniqueEntry(entries, seenEntries, {
        text: sourcePath,
        href: fileHref(sourcePath),
        kind: "file",
        priority: 0,
      });
    }

    const isDomainNode = node.type === "domain" || node.type === "flow" || node.type === "step";
    if (isDomainNode) {
      addCountedTarget(counted, node.id, domainHref(node.id), "domain", 1);
      addCountedTarget(counted, node.name, domainHref(node.id), "domain", 1);
    }
  }

  for (const [text, target] of counted) {
    if (target.count !== 1) continue;
    addUniqueEntry(entries, seenEntries, {
      text,
      href: target.href,
      kind: target.kind,
      priority: target.priority,
    });
  }

  entries.sort((a, b) => b.text.length - a.text.length || a.priority - b.priority);
  return { entries };
}

function isPathBoundary(value: string | undefined): boolean {
  return !value || !/[A-Za-z0-9_\/:-]/u.test(value);
}

function isWordBoundary(value: string | undefined): boolean {
  return !value || !/[\p{L}\p{N}_-]/u.test(value);
}

function hasBoundary(text: string, start: number, end: number, entry: AssistantReferenceEntry): boolean {
  const before = text[start - 1];
  const after = text[end];
  if (entry.kind === "file" || entry.text.includes("/") || entry.text.includes(".")) {
    return isPathBoundary(before) && isPathBoundary(after);
  }
  if (hasCjk(entry.text)) return true;
  return isWordBoundary(before) && isWordBoundary(after);
}

function rangeSuffix(value: string): { text: string; startLine: number; endLine: number } | null {
  const match = value.match(/^:(\d+)(?:-(\d+))?/u);
  if (!match) return null;
  const startLine = Number(match[1]);
  const endLine = match[2] ? Number(match[2]) : startLine;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine <= 0 || endLine < startLine) {
    return null;
  }
  return { text: match[0], startLine, endLine };
}

export function findAssistantReferenceMatches(
  text: string,
  index: AssistantReferenceIndex | null,
): AssistantReferenceMatch[] {
  if (!index || text.length === 0) return [];
  const candidates: AssistantReferenceMatch[] = [];

  for (const entry of index.entries) {
    let offset = 0;
    while (offset < text.length) {
      const start = text.indexOf(entry.text, offset);
      if (start < 0) break;
      const baseEnd = start + entry.text.length;
      const suffix = entry.kind === "file" ? rangeSuffix(text.slice(baseEnd)) : null;
      const end = suffix ? baseEnd + suffix.text.length : baseEnd;
      if (hasBoundary(text, start, end, entry)) {
        candidates.push({
          start,
          end,
          text: text.slice(start, end),
          href: suffix ? codeRangeHref(entry.text, suffix.startLine, suffix.endLine) : entry.href,
        });
      }
      offset = Math.max(baseEnd, start + 1);
    }
  }

  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const selected: AssistantReferenceMatch[] = [];
  let occupiedUntil = -1;
  for (const candidate of candidates) {
    if (candidate.start < occupiedUntil) continue;
    selected.push(candidate);
    occupiedUntil = candidate.end;
  }
  return selected;
}
