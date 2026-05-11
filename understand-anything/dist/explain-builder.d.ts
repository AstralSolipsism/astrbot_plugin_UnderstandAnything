import type { KnowledgeGraph, GraphNode, GraphEdge, Layer } from "@understand-anything/core";
export interface ExplainContext {
    projectName: string;
    path: string;
    targetNode: GraphNode | null;
    childNodes: GraphNode[];
    connectedNodes: GraphNode[];
    relevantEdges: GraphEdge[];
    layer: Layer | null;
}
/**
 * Build a context for explaining a specific file or function.
 * Supports file paths ("src/auth.ts") and path:function ("src/auth.ts:login").
 */
export declare function buildExplainContext(graph: KnowledgeGraph, path: string): ExplainContext;
/**
 * Format the explain context as a structured prompt for LLM consumption.
 */
export declare function formatExplainPrompt(ctx: ExplainContext): string;
//# sourceMappingURL=explain-builder.d.ts.map