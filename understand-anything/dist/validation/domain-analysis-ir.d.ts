import type { KnowledgeGraph } from "@understand-anything/core/types";
import { type GraphQualityIssue, type SourceInventory } from "./quality.js";
export interface DomainAnalysisIR {
    version?: string;
    domains: DomainIR[];
    crossDomainInteractions?: CrossDomainInteractionIR[];
}
export interface DomainIR {
    id?: string;
    name: string;
    summary: string;
    tags?: string[];
    sourceNodeIds?: string[];
    sourceFilePaths?: string[];
    evidence?: string[] | string;
    flows?: FlowIR[];
}
export interface FlowIR {
    id?: string;
    name: string;
    summary: string;
    tags?: string[];
    entryPoint?: string;
    entryType?: "http" | "cli" | "event" | "cron" | "manual" | "document";
    sourceNodeIds?: string[];
    sourceFilePaths?: string[];
    evidence?: string[] | string;
    steps?: StepIR[];
}
export interface StepIR {
    id?: string;
    name: string;
    summary: string;
    tags?: string[];
    sourceNodeIds?: string[];
    sourceFilePaths?: string[];
    evidence?: string[] | string;
    filePath?: string;
    lineRange?: [number, number];
}
export interface CrossDomainInteractionIR {
    fromDomainIdOrName: string;
    toDomainIdOrName: string;
    summary: string;
    sourceNodeIds?: string[];
    sourceFilePaths?: string[];
    evidence?: string[] | string;
}
export interface CompileDomainGraphResult {
    graph: KnowledgeGraph;
    issues: GraphQualityIssue[];
}
export declare function normalizeDomainAnalysisIR(raw: unknown): {
    ir: DomainAnalysisIR | null;
    issues: GraphQualityIssue[];
};
export declare function compileDomainGraph(ir: DomainAnalysisIR, knowledgeGraph: KnowledgeGraph, inventory: SourceInventory, meta: Record<string, unknown>): CompileDomainGraphResult;
export declare function domainGraphToIR(graph: KnowledgeGraph): DomainAnalysisIR;
//# sourceMappingURL=domain-analysis-ir.d.ts.map