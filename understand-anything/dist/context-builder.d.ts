import type { KnowledgeGraph, GraphNode, GraphEdge, Layer } from "@understand-anything/core";
export interface ChatContext {
    projectName: string;
    projectDescription: string;
    languages: string[];
    frameworks: string[];
    relevantNodes: GraphNode[];
    relevantEdges: GraphEdge[];
    relevantLayers: Layer[];
    query: string;
}
/**
 * Build a ChatContext by searching the knowledge graph for nodes relevant
 * to the user's query, expanding 1 hop via edges, and collecting the
 * associated layers.
 */
export declare function buildChatContext(graph: KnowledgeGraph, query: string, maxNodes?: number): ChatContext;
/**
 * Format the ChatContext as a readable markdown string for LLM consumption.
 */
export declare function formatContextForPrompt(context: ChatContext): string;
//# sourceMappingURL=context-builder.d.ts.map