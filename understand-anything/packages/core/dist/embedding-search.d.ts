import type { GraphNode } from "./types.js";
import type { SearchResult } from "./search.js";
export interface SemanticSearchOptions {
    limit?: number;
    threshold?: number;
    types?: string[];
}
/**
 * Compute cosine similarity between two vectors.
 * Returns 0 if either vector has zero magnitude.
 */
export declare function cosineSimilarity(a: number[], b: number[]): number;
/**
 * Semantic search engine using vector embeddings.
 * Stores pre-computed embeddings for graph nodes and performs
 * cosine similarity search against query embeddings.
 */
export declare class SemanticSearchEngine {
    private nodes;
    private embeddings;
    constructor(nodes: GraphNode[], embeddings: Record<string, number[]>);
    hasEmbeddings(): boolean;
    addEmbedding(nodeId: string, embedding: number[]): void;
    search(queryEmbedding: number[], options?: SemanticSearchOptions): SearchResult[];
    updateNodes(nodes: GraphNode[]): void;
}
//# sourceMappingURL=embedding-search.d.ts.map