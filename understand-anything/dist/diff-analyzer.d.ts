import type { KnowledgeGraph, GraphNode, GraphEdge, Layer } from "@understand-anything/core";
export interface DiffContext {
    projectName: string;
    changedFiles: string[];
    changedNodes: GraphNode[];
    affectedNodes: GraphNode[];
    impactedEdges: GraphEdge[];
    affectedLayers: Layer[];
    unmappedFiles: string[];
}
/**
 * Map a list of changed file paths to knowledge graph nodes and
 * identify the ripple effect (affected nodes, layers, edges).
 */
export declare function buildDiffContext(graph: KnowledgeGraph, changedFiles: string[]): DiffContext;
/**
 * Format the diff analysis as structured markdown for LLM or human consumption.
 */
export declare function formatDiffAnalysis(ctx: DiffContext): string;
//# sourceMappingURL=diff-analyzer.d.ts.map