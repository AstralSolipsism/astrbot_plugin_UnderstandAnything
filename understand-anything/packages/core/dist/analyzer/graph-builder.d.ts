import type { KnowledgeGraph, GraphNode, StructuralAnalysis, DefinitionInfo, ServiceInfo, EndpointInfo, StepInfo, ResourceInfo, SectionInfo } from "../types.js";
import { LanguageRegistry } from "../languages/language-registry.js";
interface FileMeta {
    summary: string;
    tags: string[];
    complexity: "simple" | "moderate" | "complex";
}
interface FileAnalysisMeta extends FileMeta {
    summaries: Record<string, string>;
    fileSummary: string;
}
interface NonCodeFileMeta extends FileMeta {
    nodeType: GraphNode["type"];
}
interface NonCodeFileAnalysisMeta extends NonCodeFileMeta {
    definitions?: DefinitionInfo[];
    services?: ServiceInfo[];
    endpoints?: EndpointInfo[];
    steps?: StepInfo[];
    resources?: ResourceInfo[];
    sections?: SectionInfo[];
}
export declare class GraphBuilder {
    private readonly nodes;
    private readonly edges;
    private readonly languages;
    private readonly nodeIds;
    private readonly edgeKeys;
    private readonly projectName;
    private readonly gitHash;
    private readonly languageRegistry;
    constructor(projectName: string, gitHash: string, languageRegistry?: LanguageRegistry);
    private detectLanguage;
    private static basename;
    addFile(filePath: string, meta: FileMeta): void;
    addFileWithAnalysis(filePath: string, analysis: StructuralAnalysis, meta: FileAnalysisMeta): void;
    addImportEdge(fromFile: string, toFile: string): void;
    addCallEdge(callerFile: string, callerFunc: string, calleeFile: string, calleeFunc: string): void;
    addNonCodeFile(filePath: string, meta: NonCodeFileMeta): string;
    addNonCodeFileWithAnalysis(filePath: string, meta: NonCodeFileAnalysisMeta): void;
    private addChildNode;
    private mapKindToNodeType;
    build(): KnowledgeGraph;
}
export {};
//# sourceMappingURL=graph-builder.d.ts.map