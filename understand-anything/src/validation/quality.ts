import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createIgnoreFilter } from "@understand-anything/core/ignore-filter";
import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";

export type SourceInventoryKind = "file" | "directory";
export type SourceInventoryCategory = "code" | "docs" | "config" | "infra" | "data" | "script" | "asset";
export type QualityIssueLevel = "fatal" | "error" | "warning" | "info";
export type GraphQualityKind = "knowledge" | "domain";

export interface SourceInventoryEntry {
  path: string;
  kind: SourceInventoryKind;
  language: string;
  sizeBytes: number;
  lineCount: number;
  hash: string;
  category: SourceInventoryCategory;
}

export interface SourceInventory {
  version: "1.0.0";
  generatedAt: string;
  gitCommitHash?: string;
  entries: SourceInventoryEntry[];
  totals: {
    files: number;
    directories: number;
    bytes: number;
  };
}

export interface BuildSourceInventoryOptions {
  graphRoot?: string;
  gitCommitHash?: string;
}

export interface GraphQualityIssue {
  level: QualityIssueLevel;
  code: string;
  graph: GraphQualityKind | "fingerprints" | "source-inventory";
  message: string;
  nodeId?: string;
  edgeIndex?: number;
  path?: string;
}

export interface GraphQualitySummary {
  graph: GraphQualityKind;
  nodeCount: number;
  edgeCount: number;
  removedNodeCount: number;
  removedEdgeCount: number;
  issueCount: number;
}

export interface QualityReport {
  version: "1.0.0";
  generatedAt: string;
  projectId: string;
  inventory: {
    fileCount: number;
    directoryCount: number;
    byteCount: number;
  };
  graphs: GraphQualitySummary[];
  fingerprints: {
    fileCount: number;
    candidateCount: number;
    coverageRatio: number;
    missingCandidatePaths: string[];
  };
  issueCounts: Record<QualityIssueLevel, number>;
  issues: GraphQualityIssue[];
}

export interface GraphQualityResult {
  graph: KnowledgeGraph;
  changed: boolean;
  issues: GraphQualityIssue[];
  summary: GraphQualitySummary;
}

const SOURCE_INVENTORY_FILE = "source-inventory.json";
const QUALITY_REPORT_FILE = "quality-report.json";
const TEXT_PLACEHOLDER_PATTERNS = [
  "文件不存在",
  "不存在或已被重命名",
  "未在磁盘上找到",
  "文件未在磁盘上找到",
  "该文件在仓库中不存在",
];

const CODE_NODE_TYPES = new Set<GraphNode["type"]>(["file", "function", "class", "module", "config", "document", "service", "table", "endpoint", "pipeline", "schema", "resource"]);
const CODE_FILE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".kt", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".rb", ".php",
]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt"]);
const CONFIG_EXTENSIONS = new Set([".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".cfg", ".ini", ".env"]);
const DATA_EXTENSIONS = new Set([".sql", ".graphql", ".gql", ".proto", ".prisma", ".schema.json", ".csv"]);
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd"]);
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".pdf", ".zip", ".tar", ".gz"]);

function uaDir(projectRoot: string): string {
  return join(projectRoot, ".understand-anything");
}

export function sourceInventoryPath(projectRoot: string): string {
  return join(uaDir(projectRoot), SOURCE_INVENTORY_FILE);
}

export function qualityReportPath(projectRoot: string): string {
  return join(uaDir(projectRoot), QUALITY_REPORT_FILE);
}

function isInsideDirectory(parent: string, candidate: string, allowEqual = false): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  if (rel === "") return allowEqual;
  return !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function normalizeInventoryPath(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim() || input.includes("\0") || input.includes("\\") || input.startsWith("/")) return null;
  const normalizedPath = normalize(input);
  if (normalizedPath === "." || normalizedPath === ".." || normalizedPath.startsWith(`..${sep}`) || isAbsolute(normalizedPath)) return null;
  return normalizedPath.split(sep).join("/");
}

function languageFromPath(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  const byExt: Record<string, string> = {
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "markup",
    java: "java",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
  };
  if (filePath.endsWith("Dockerfile") || filePath.includes("/Dockerfile")) return "dockerfile";
  if (filePath.endsWith("Makefile") || filePath.includes("/Makefile")) return "makefile";
  return ext ? byExt[ext] ?? ext : "text";
}

function categoryFromPath(filePath: string, kind: SourceInventoryKind): SourceInventoryCategory {
  const lower = filePath.toLowerCase();
  const ext = extname(lower);
  if (ASSET_EXTENSIONS.has(ext)) return "asset";
  if (lower.startsWith("docs/") || lower.startsWith("readmes/") || DOC_EXTENSIONS.has(ext)) return "docs";
  if (
    lower.startsWith("deploy/") ||
    lower.startsWith(".github/") ||
    lower.includes("/k8s/") ||
    lower.includes("/kubernetes/") ||
    lower.endsWith("dockerfile") ||
    lower.includes("docker-compose") ||
    lower.endsWith(".tf") ||
    lower.endsWith("jenkinsfile") ||
    lower.endsWith("procfile") ||
    lower.includes("railway") ||
    lower.includes("render") ||
    lower.includes("fly.toml")
  ) {
    return "infra";
  }
  if (DATA_EXTENSIONS.has(ext) || lower.endsWith(".schema.json")) return "data";
  if (SCRIPT_EXTENSIONS.has(ext) || lower.startsWith("scripts/")) return "script";
  if (CONFIG_EXTENSIONS.has(ext) || lower.endsWith("package.json") || lower.endsWith("tsconfig.json") || lower.endsWith("go.mod") || lower.endsWith("cargo.toml")) return "config";
  if (CODE_FILE_EXTENSIONS.has(ext)) return "code";
  return kind === "directory" ? "code" : "asset";
}

function listTrackedFiles(projectRoot: string): string[] | null {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: projectRoot,
    encoding: "utf-8",
    windowsHide: true,
    maxBuffer: 24 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout.split("\0").map((item) => normalizeInventoryPath(item)).filter((item): item is string => item !== null);
}

function listFilesRecursively(projectRoot: string, relativeDir = ""): string[] {
  const directory = resolve(projectRoot, relativeDir);
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const output: string[] = [];
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (relativePath === ".understand-anything" || relativePath.startsWith(".understand-anything/")) continue;
    if (entry.isDirectory()) {
      output.push(...listFilesRecursively(projectRoot, relativePath));
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) output.push(relativePath);
  }
  return output;
}

function parentDirectories(filePath: string): string[] {
  const parts = filePath.split("/");
  const dirs: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    dirs.push(parts.slice(0, index).join("/"));
  }
  return dirs;
}

function contentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function lineCount(buffer: Buffer): number {
  if (buffer.includes(0)) return 0;
  const text = buffer.toString("utf-8");
  if (text.length === 0) return 0;
  return text.split(/\r\n|\n|\r/).length;
}

function buildFileEntry(projectRoot: string, relativePath: string): SourceInventoryEntry | null {
  const absolutePath = resolve(projectRoot, relativePath);
  if (!isInsideDirectory(projectRoot, absolutePath)) return null;
  let realPath: string;
  let fileStat: ReturnType<typeof statSync>;
  try {
    realPath = realpathSync(absolutePath);
    if (!isInsideDirectory(projectRoot, realPath)) return null;
    fileStat = statSync(realPath);
  } catch {
    return null;
  }
  if (!fileStat.isFile()) return null;
  const buffer = readFileSync(realPath);
  return {
    path: relativePath,
    kind: "file",
    language: languageFromPath(relativePath),
    sizeBytes: fileStat.size,
    lineCount: lineCount(buffer),
    hash: contentHash(buffer),
    category: categoryFromPath(relativePath, "file"),
  };
}

function buildDirectoryEntry(relativePath: string): SourceInventoryEntry {
  return {
    path: relativePath,
    kind: "directory",
    language: "directory",
    sizeBytes: 0,
    lineCount: 0,
    hash: createHash("sha256").update(`directory:${relativePath}`).digest("hex"),
    category: categoryFromPath(relativePath, "directory"),
  };
}

export function buildSourceInventory(projectRoot: string, gitCommitHash?: string): SourceInventory;
export function buildSourceInventory(projectRoot: string, options?: BuildSourceInventoryOptions): SourceInventory;
export function buildSourceInventory(
  projectRoot: string,
  optionsOrGitCommitHash?: BuildSourceInventoryOptions | string,
): SourceInventory {
  const options = typeof optionsOrGitCommitHash === "string"
    ? { gitCommitHash: optionsOrGitCommitHash }
    : optionsOrGitCommitHash ?? {};
  const ignoreFilter = createIgnoreFilter(projectRoot, options.graphRoot);
  const rawFiles = listTrackedFiles(projectRoot) ?? listFilesRecursively(projectRoot);
  const filePaths = [...new Set(rawFiles)]
    .map((item) => normalizeInventoryPath(item))
    .filter((item): item is string => item !== null)
    .filter((item) => !ignoreFilter.isIgnored(item))
    .sort();

  const entries: SourceInventoryEntry[] = [];
  const directoryPaths = new Set<string>();
  for (const filePath of filePaths) {
    const entry = buildFileEntry(projectRoot, filePath);
    if (!entry) continue;
    entries.push(entry);
    for (const dir of parentDirectories(filePath)) {
      if (!ignoreFilter.isIgnored(`${dir}/`)) directoryPaths.add(dir);
    }
  }

  for (const dir of [...directoryPaths].sort()) entries.push(buildDirectoryEntry(dir));
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    gitCommitHash: options.gitCommitHash,
    entries,
    totals: {
      files: entries.filter((entry) => entry.kind === "file").length,
      directories: entries.filter((entry) => entry.kind === "directory").length,
      bytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    },
  };
}

export function saveSourceInventory(projectRoot: string, inventory: SourceInventory): void {
  mkdirSync(uaDir(projectRoot), { recursive: true });
  writeFileSync(sourceInventoryPath(projectRoot), `${JSON.stringify(inventory, null, 2)}\n`, "utf-8");
}

export function readSourceInventory(projectRoot: string): SourceInventory | null {
  const filePath = sourceInventoryPath(projectRoot);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf-8")) as SourceInventory;
}

export function sourceInventoryEntryMap(inventory: SourceInventory): Map<string, SourceInventoryEntry> {
  return new Map(inventory.entries.map((entry) => [entry.path, entry]));
}

export function sourceInventoryFileSet(inventory: SourceInventory): Set<string> {
  return new Set(inventory.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
}

function issue(
  issues: GraphQualityIssue[],
  level: QualityIssueLevel,
  graph: GraphQualityIssue["graph"],
  code: string,
  message: string,
  details: Partial<GraphQualityIssue> = {},
): void {
  issues.push({ level, graph, code, message, ...details });
}

function collectStringLeaves(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    const text = value.trim();
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, output);
  }
}

function pushStringField(record: Record<string, unknown>, field: string, output: string[]): void {
  const value = record[field];
  if (typeof value === "string" && value.trim()) output.push(value.trim());
}

function collectDomainMetaLanguage(value: unknown, output: string[]): void {
  const meta = asRecord(value);
  if (!meta) return;
  collectStringLeaves(meta.evidence, output);
  collectStringLeaves(meta.businessRules, output);
  collectStringLeaves(meta.crossDomainInteractions, output);
}

export function collectGraphVisibleDescriptions(graph: unknown): string[] {
  const output: string[] = [];
  const record = asRecord(graph);
  if (!record) return output;
  const project = asRecord(record.project);
  if (project) pushStringField(project, "description", output);

  for (const node of Array.isArray(record.nodes) ? record.nodes : []) {
    const nodeRecord = asRecord(node);
    if (!nodeRecord) continue;
    pushStringField(nodeRecord, "summary", output);
    pushStringField(nodeRecord, "description", output);
    collectDomainMetaLanguage(nodeRecord.domainMeta, output);
  }

  for (const layer of Array.isArray(record.layers) ? record.layers : []) {
    const layerRecord = asRecord(layer);
    if (layerRecord) pushStringField(layerRecord, "description", output);
  }

  for (const tourStep of Array.isArray(record.tour) ? record.tour : []) {
    const stepRecord = asRecord(tourStep);
    if (!stepRecord) continue;
    pushStringField(stepRecord, "title", output);
    pushStringField(stepRecord, "description", output);
  }

  return output;
}

function containsChinese(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
}

export function validateChineseVisibleContent(fileName: string, graph: unknown): void {
  const descriptions = collectGraphVisibleDescriptions(graph).filter((text) => text.length >= 2);
  if (descriptions.length === 0) {
    throw new Error(`${fileName} 中文内容校验失败：缺少项目说明、节点摘要、层说明或领域流程说明。`);
  }

  const chineseCount = descriptions.filter(containsChinese).length;
  const ratio = chineseCount / descriptions.length;
  if (chineseCount === 0 || (descriptions.length >= 4 && ratio < 0.5)) {
    throw new Error(
      `${fileName} 中文内容校验失败：用户可见说明未按中文输出（${chineseCount}/${descriptions.length} 条包含中文）。请重新分析并确保项目说明、节点摘要、层说明和领域流程说明使用中文。`,
    );
  }
}

function graphTextContainsPlaceholder(node: GraphNode): boolean {
  const languageText: string[] = [];
  collectDomainMetaLanguage(node.domainMeta, languageText);
  const text = [
    node.name,
    node.summary,
    (node as GraphNode & { description?: string }).description,
    ...languageText,
  ].filter(Boolean).join("\n");
  return TEXT_PLACEHOLDER_PATTERNS.some((pattern) => text.includes(pattern));
}

function ensureDomainMeta(node: GraphNode): NonNullable<GraphNode["domainMeta"]> & Record<string, unknown> {
  const record = node as GraphNode & { domainMeta?: NonNullable<GraphNode["domainMeta"]> & Record<string, unknown> };
  if (!record.domainMeta) record.domainMeta = {};
  return record.domainMeta;
}

function addDomainEvidence(node: GraphNode, text: string): void {
  const meta = ensureDomainMeta(node);
  const existing = Array.isArray(meta.evidence) ? meta.evidence.filter((item): item is string => typeof item === "string") : [];
  if (!existing.includes(text)) existing.push(text);
  meta.evidence = existing;
}

function hasDomainProvenance(node: GraphNode): boolean {
  const meta = node.domainMeta as (NonNullable<GraphNode["domainMeta"]> & Record<string, unknown>) | undefined;
  if (!meta) return false;
  return (
    (Array.isArray(meta.sourceNodeIds) && meta.sourceNodeIds.length > 0) ||
    (Array.isArray(meta.sourceFilePaths) && meta.sourceFilePaths.length > 0) ||
    (Array.isArray(meta.evidence) && meta.evidence.length > 0) ||
    (typeof meta.evidence === "string" && meta.evidence.trim().length > 0)
  );
}

function addDomainSourceFile(node: GraphNode, filePath: string): void {
  const meta = ensureDomainMeta(node);
  const existing = Array.isArray(meta.sourceFilePaths) ? meta.sourceFilePaths.filter((item): item is string => typeof item === "string") : [];
  if (!existing.includes(filePath)) existing.push(filePath);
  meta.sourceFilePaths = existing;
}

function sanitizeDomainSourceFilePaths(
  node: GraphNode,
  inventoryMap: Map<string, SourceInventoryEntry>,
  issues: GraphQualityIssue[],
): boolean {
  const meta = node.domainMeta as (NonNullable<GraphNode["domainMeta"]> & Record<string, unknown>) | undefined;
  if (!meta || !Array.isArray(meta.sourceFilePaths)) return false;

  let changed = false;
  const originalLength = meta.sourceFilePaths.length;
  const nextPaths: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of meta.sourceFilePaths) {
    const normalizedPath = normalizeInventoryPath(rawPath);
    const rawPathText = typeof rawPath === "string" ? rawPath : undefined;
    if (!normalizedPath) {
      changed = true;
      issue(issues, "warning", "domain", "invalid-domain-source-filepath-removed", `领域来源路径不合法，已移除：${node.name}`, { nodeId: node.id, path: rawPathText });
      continue;
    }

    const entry = inventoryMap.get(normalizedPath);
    if (!entry) {
      changed = true;
      issue(issues, "warning", "domain", "missing-domain-source-filepath-removed", `领域来源路径不存在，已移除：${node.name}`, { nodeId: node.id, path: normalizedPath });
      continue;
    }

    if (entry.kind !== "file") {
      changed = true;
      issue(issues, "warning", "domain", "directory-domain-source-filepath-removed", `领域来源路径指向目录，已移除：${node.name}`, { nodeId: node.id, path: normalizedPath });
      continue;
    }

    if (seen.has(normalizedPath)) {
      changed = true;
      issue(issues, "warning", "domain", "duplicate-domain-source-filepath-removed", `领域来源路径重复，已去重：${node.name}`, { nodeId: node.id, path: normalizedPath });
      continue;
    }

    seen.add(normalizedPath);
    nextPaths.push(normalizedPath);
    if (rawPath !== normalizedPath) changed = true;
  }

  const removeEmptySourcePaths = nextPaths.length === 0;
  if (!removeEmptySourcePaths) {
    meta.sourceFilePaths = nextPaths;
  } else {
    delete meta.sourceFilePaths;
  }

  return changed || nextPaths.length !== originalLength || removeEmptySourcePaths;
}

function removeNodeReferences(graph: KnowledgeGraph, removedNodeIds: Set<string>): number {
  const originalEdgeCount = graph.edges.length;
  graph.edges = graph.edges.filter((edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target));
  for (const layer of graph.layers) {
    layer.nodeIds = layer.nodeIds.filter((nodeId) => !removedNodeIds.has(nodeId));
  }
  graph.tour = graph.tour
    .map((step) => ({ ...step, nodeIds: step.nodeIds.filter((nodeId) => !removedNodeIds.has(nodeId)) }))
    .filter((step) => step.nodeIds.length > 0);
  return originalEdgeCount - graph.edges.length;
}

function lineRangeIsValid(range: unknown, entry: SourceInventoryEntry | undefined): boolean {
  if (!Array.isArray(range) || range.length !== 2) return false;
  const [start, end] = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 1 || end < start) return false;
  return !(entry && entry.lineCount > 0 && end > entry.lineCount);
}

function removeLineRange(node: GraphNode): void {
  delete (node as GraphNode & { lineRange?: [number, number] }).lineRange;
}

export function repairAndAssessGraphQuality(
  graph: KnowledgeGraph,
  graphKind: GraphQualityKind,
  inventory: SourceInventory,
): GraphQualityResult {
  const issues: GraphQualityIssue[] = [];
  const inventoryMap = sourceInventoryEntryMap(inventory);
  let changed = false;
  let removedEdgeCount = 0;
  const removedNodeIds = new Set<string>();
  const seenNodeIds = new Set<string>();
  const duplicateNodeIds = new Set<string>();

  for (const node of graph.nodes) {
    if (seenNodeIds.has(node.id)) duplicateNodeIds.add(node.id);
    seenNodeIds.add(node.id);
  }
  for (const id of duplicateNodeIds) {
    issue(issues, "fatal", graphKind, "duplicate-node-id", `图谱存在重复节点 ID：${id}`, { nodeId: id });
  }

  graph.edges = graph.edges.filter((edge, index) => {
    if (edge.source !== edge.target) return true;
    changed = true;
    removedEdgeCount += 1;
    issue(issues, "warning", graphKind, "self-edge-removed", `已移除自引用关系：${edge.source}`, { edgeIndex: index });
    return false;
  });

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  graph.edges = graph.edges.filter((edge, index) => {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) return true;
    changed = true;
    removedEdgeCount += 1;
    issue(issues, "warning", graphKind, "dangling-edge-removed", `已移除悬空关系：${edge.source} -> ${edge.target}`, { edgeIndex: index });
    return false;
  });

  for (const node of graph.nodes) {
    if (graphKind === "domain") {
      if (sanitizeDomainSourceFilePaths(node, inventoryMap, issues)) changed = true;
      if (graphTextContainsPlaceholder(node)) {
        issue(issues, "error", graphKind, "placeholder-domain-text", `领域节点包含缺失文件占位说明，需要重跑领域分析：${node.name}`, { nodeId: node.id, path: node.filePath });
      }
    }

    if (graphKind === "knowledge" && graphTextContainsPlaceholder(node)) {
      removedNodeIds.add(node.id);
      issue(issues, "warning", graphKind, "placeholder-node-removed", `已移除包含缺失文件占位说明的节点：${node.name}`, { nodeId: node.id, path: node.filePath });
      continue;
    }

    if (typeof node.filePath === "string") {
      const normalizedPath = normalizeInventoryPath(node.filePath);
      if (!normalizedPath) {
        if (graphKind === "domain") {
          delete (node as GraphNode & { filePath?: string }).filePath;
          removeLineRange(node);
          addDomainEvidence(node, `原 filePath 不合法，已移除：${node.filePath}`);
          changed = true;
          issue(issues, "warning", graphKind, "invalid-domain-filepath-removed", `已移除领域节点不合法 filePath：${node.name}`, { nodeId: node.id });
        } else {
          removedNodeIds.add(node.id);
          issue(issues, "warning", graphKind, "invalid-filepath-node-removed", `已移除不合法 filePath 节点：${node.name}`, { nodeId: node.id, path: node.filePath });
        }
        continue;
      }

      if (node.filePath !== normalizedPath) {
        node.filePath = normalizedPath;
        changed = true;
      }

      const entry = inventoryMap.get(normalizedPath);
      if (!entry) {
        if (graphKind === "domain") {
          delete (node as GraphNode & { filePath?: string }).filePath;
          removeLineRange(node);
          addDomainEvidence(node, `原 filePath ${normalizedPath} 当前不在源码清单中，需要后续重跑领域定位。`);
          changed = true;
          issue(issues, "warning", graphKind, "missing-domain-filepath-removed", `领域节点引用了不存在路径，已移除 filePath：${node.name}`, { nodeId: node.id, path: normalizedPath });
        } else {
          removedNodeIds.add(node.id);
          issue(issues, "warning", graphKind, "missing-file-node-removed", `已移除引用不存在路径的节点：${node.name}`, { nodeId: node.id, path: normalizedPath });
        }
        continue;
      }

      if (entry.kind === "directory") {
        if (graphKind === "domain") {
          const meta = ensureDomainMeta(node);
          meta.scopePath = normalizedPath;
          delete (node as GraphNode & { filePath?: string }).filePath;
          removeLineRange(node);
          addDomainEvidence(node, `该领域步骤定位到目录范围：${normalizedPath}`);
          changed = true;
          issue(issues, "warning", graphKind, "domain-filepath-directory-migrated", `领域节点目录型 filePath 已迁移到 domainMeta.scopePath：${node.name}`, { nodeId: node.id, path: normalizedPath });
        } else {
          removedNodeIds.add(node.id);
          issue(issues, "warning", graphKind, "directory-file-node-removed", `已移除 filePath 指向目录的节点：${node.name}`, { nodeId: node.id, path: normalizedPath });
        }
        continue;
      }

      if (graphKind === "domain") addDomainSourceFile(node, normalizedPath);

      if (node.lineRange) {
        const isZeroRange = node.lineRange[0] === 0 && node.lineRange[1] === 0;
        if (isZeroRange && graphKind === "domain" && node.type === "step") {
          issue(issues, "warning", graphKind, "domain-zero-line-range", `领域步骤缺少精确行号：${node.name}`, { nodeId: node.id, path: normalizedPath });
        } else if (!lineRangeIsValid(node.lineRange, entry)) {
          removeLineRange(node);
          changed = true;
          issue(issues, "warning", graphKind, "invalid-line-range-removed", `已移除无效行号范围：${node.name}`, { nodeId: node.id, path: normalizedPath });
        }
      } else if (graphKind === "knowledge" && CODE_NODE_TYPES.has(node.type)) {
        issue(issues, "info", graphKind, "missing-line-range", `节点没有精确行号范围：${node.name}`, { nodeId: node.id, path: normalizedPath });
      }
    }

    if (graphKind === "domain" && (node.type === "domain" || node.type === "flow" || node.type === "step") && !hasDomainProvenance(node)) {
      addDomainEvidence(node, "由 AstrBot 领域分析生成，当前缺少更细粒度来源节点，建议后续重跑领域分析补齐 provenance。");
      changed = true;
      issue(issues, "warning", graphKind, "domain-provenance-added", `领域节点缺少来源证据，已补充 evidence：${node.name}`, { nodeId: node.id });
    }
  }

  if (removedNodeIds.size > 0) {
    graph.nodes = graph.nodes.filter((node) => !removedNodeIds.has(node.id));
    removedEdgeCount += removeNodeReferences(graph, removedNodeIds);
    changed = true;
  }

  if (graphKind === "domain") {
    const ids = new Set(graph.nodes.map((node) => node.id));
    const domainIds = new Set(graph.nodes.filter((node) => node.type === "domain").map((node) => node.id));
    const flowIds = new Set(graph.nodes.filter((node) => node.type === "flow").map((node) => node.id));
    const stepIds = new Set(graph.nodes.filter((node) => node.type === "step").map((node) => node.id));
    const flowsWithDomain = new Set(graph.edges.filter((edge) => edge.type === "contains_flow" && domainIds.has(edge.source) && ids.has(edge.target)).map((edge) => edge.target));
    const stepsWithFlow = new Set(graph.edges.filter((edge) => edge.type === "flow_step" && flowIds.has(edge.source) && ids.has(edge.target)).map((edge) => edge.target));
    for (const flowId of flowIds) {
      if (!flowsWithDomain.has(flowId)) issue(issues, "fatal", graphKind, "orphan-flow", `领域流程没有所属 domain：${flowId}`, { nodeId: flowId });
    }
    for (const stepId of stepIds) {
      if (!stepsWithFlow.has(stepId)) issue(issues, "fatal", graphKind, "orphan-step", `领域步骤没有所属 flow：${stepId}`, { nodeId: stepId });
    }
    for (const flowId of flowIds) {
      const stepEdges = graph.edges.filter((edge) => edge.type === "flow_step" && edge.source === flowId);
      for (let index = 1; index < stepEdges.length; index += 1) {
        if (stepEdges[index].weight < stepEdges[index - 1].weight) {
          issue(issues, "error", graphKind, "unstable-step-order", `领域流程步骤顺序不稳定：${flowId}`, { nodeId: flowId });
          break;
        }
      }
    }
  }

  const fatalCount = issues.filter((item) => item.level === "fatal").length;
  const errorCount = issues.filter((item) => item.level === "error").length;
  const summary: GraphQualitySummary = {
    graph: graphKind,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    removedNodeCount: removedNodeIds.size,
    removedEdgeCount,
    issueCount: issues.length,
  };

  if (fatalCount === 0 && errorCount === 0) return { graph, changed, issues, summary };
  return { graph, changed, issues, summary };
}

function graphFilePaths(graph: KnowledgeGraph | null | undefined): Set<string> {
  const output = new Set<string>();
  for (const node of graph?.nodes ?? []) {
    const normalizedPath = normalizeInventoryPath(node.filePath);
    if (normalizedPath) output.add(normalizedPath);
    for (const sourcePath of node.domainMeta?.sourceFilePaths ?? []) {
      const normalizedSourcePath = normalizeInventoryPath(sourcePath);
      if (normalizedSourcePath) output.add(normalizedSourcePath);
    }
  }
  return output;
}

export function collectFingerprintCandidatePaths(
  inventory: SourceInventory,
  graphs: Array<KnowledgeGraph | null | undefined>,
  maxFileBytes: number,
): string[] {
  const graphPaths = new Set(graphs.flatMap((graph) => [...graphFilePaths(graph)]));
  const candidates = new Set<string>();
  for (const entry of inventory.entries) {
    if (entry.kind !== "file" || entry.sizeBytes > maxFileBytes || entry.category === "asset") continue;
    if (graphPaths.has(entry.path) || entry.category === "code" || entry.category === "config" || entry.category === "docs" || entry.category === "infra" || entry.category === "data" || entry.category === "script") {
      candidates.add(entry.path);
    }
  }
  return [...candidates].sort();
}

export function buildQualityReport(options: {
  projectId: string;
  inventory: SourceInventory;
  graphResults: GraphQualityResult[];
  fingerprintFiles: string[];
  fingerprintCandidates: string[];
  extraIssues?: GraphQualityIssue[];
}): QualityReport {
  const fingerprintSet = new Set(options.fingerprintFiles);
  const missingCandidatePaths = options.fingerprintCandidates.filter((item) => !fingerprintSet.has(item));
  const issues = [...options.graphResults.flatMap((result) => result.issues), ...(options.extraIssues ?? [])];
  const issueCounts: Record<QualityIssueLevel, number> = { fatal: 0, error: 0, warning: 0, info: 0 };
  for (const item of issues) issueCounts[item.level] += 1;
  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    projectId: options.projectId,
    inventory: {
      fileCount: options.inventory.totals.files,
      directoryCount: options.inventory.totals.directories,
      byteCount: options.inventory.totals.bytes,
    },
    graphs: options.graphResults.map((result) => result.summary),
    fingerprints: {
      fileCount: options.fingerprintFiles.length,
      candidateCount: options.fingerprintCandidates.length,
      coverageRatio: options.fingerprintCandidates.length === 0 ? 1 : options.fingerprintFiles.length / options.fingerprintCandidates.length,
      missingCandidatePaths: missingCandidatePaths.slice(0, 200),
    },
    issueCounts,
    issues,
  };
}

export function saveQualityReport(projectRoot: string, report: QualityReport): void {
  mkdirSync(uaDir(projectRoot), { recursive: true });
  writeFileSync(qualityReportPath(projectRoot), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}
