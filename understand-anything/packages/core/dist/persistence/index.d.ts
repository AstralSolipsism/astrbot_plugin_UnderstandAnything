import type { KnowledgeGraph, AnalysisMeta, ProjectConfig } from "../types.js";
import type { FingerprintStore } from "../fingerprint.js";
export declare function saveGraph(projectRoot: string, graph: KnowledgeGraph): void;
export declare function loadGraph(projectRoot: string, options?: {
    validate?: boolean;
}): KnowledgeGraph | null;
export declare function saveMeta(projectRoot: string, meta: AnalysisMeta): void;
export declare function loadMeta(projectRoot: string): AnalysisMeta | null;
export declare function saveFingerprints(projectRoot: string, store: FingerprintStore): void;
export declare function loadFingerprints(projectRoot: string): FingerprintStore | null;
export declare function saveConfig(projectRoot: string, config: ProjectConfig): void;
export declare function loadConfig(projectRoot: string): ProjectConfig;
export declare function saveDomainGraph(projectRoot: string, graph: KnowledgeGraph): void;
export declare function loadDomainGraph(projectRoot: string, options?: {
    validate?: boolean;
}): KnowledgeGraph | null;
//# sourceMappingURL=index.d.ts.map