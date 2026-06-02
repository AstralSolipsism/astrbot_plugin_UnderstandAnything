import type { KnowledgeGraph } from "@understand-anything/core/types";
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
export declare function sourceInventoryPath(projectRoot: string): string;
export declare function qualityReportPath(projectRoot: string): string;
export declare function normalizeInventoryPath(input: unknown): string | null;
export declare function buildSourceInventory(projectRoot: string, gitCommitHash?: string): SourceInventory;
export declare function buildSourceInventory(projectRoot: string, options?: BuildSourceInventoryOptions): SourceInventory;
export declare function saveSourceInventory(projectRoot: string, inventory: SourceInventory): void;
export declare function readSourceInventory(projectRoot: string): SourceInventory | null;
export declare function sourceInventoryEntryMap(inventory: SourceInventory): Map<string, SourceInventoryEntry>;
export declare function sourceInventoryFileSet(inventory: SourceInventory): Set<string>;
export declare function collectGraphVisibleDescriptions(graph: unknown): string[];
export declare function validateChineseVisibleContent(fileName: string, graph: unknown): void;
export declare function repairAndAssessGraphQuality(graph: KnowledgeGraph, graphKind: GraphQualityKind, inventory: SourceInventory): GraphQualityResult;
export declare function collectFingerprintCandidatePaths(inventory: SourceInventory, graphs: Array<KnowledgeGraph | null | undefined>, maxFileBytes: number): string[];
export declare function buildQualityReport(options: {
    projectId: string;
    inventory: SourceInventory;
    graphResults: GraphQualityResult[];
    fingerprintFiles: string[];
    fingerprintCandidates: string[];
    extraIssues?: GraphQualityIssue[];
}): QualityReport;
export declare function saveQualityReport(projectRoot: string, report: QualityReport): void;
//# sourceMappingURL=quality.d.ts.map