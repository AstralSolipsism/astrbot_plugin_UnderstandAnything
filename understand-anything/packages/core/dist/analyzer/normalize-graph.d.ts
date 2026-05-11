/**
 * Normalizes a node ID to the canonical `type:path` format.
 * Handles: double-prefixed IDs, project-name-prefixed IDs, bare paths.
 * Idempotent — correct IDs pass through unchanged.
 */
export declare function normalizeNodeId(id: string, node: {
    type: string;
    filePath?: string;
    name?: string;
    parentFlowSlug?: string;
}): string;
/**
 * Normalizes a complexity value to one of "simple" | "moderate" | "complex".
 * Handles both string aliases and numeric scales — defaults to "moderate".
 */
export declare function normalizeComplexity(value: unknown): "simple" | "moderate" | "complex";
export interface DroppedEdge {
    source: string;
    target: string;
    type: string;
    reason: "missing-source" | "missing-target" | "missing-both";
}
export interface NormalizationStats {
    idsFixed: number;
    complexityFixed: number;
    edgesRewritten: number;
    danglingEdgesDropped: number;
    droppedEdges: DroppedEdge[];
}
export interface NormalizeBatchResult {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
    idMap: Map<string, string>;
    stats: NormalizationStats;
}
/**
 * Normalizes a merged batch output: fixes node IDs and numeric complexity,
 * rewrites edge references, deduplicates nodes and edges, and drops dangling edges.
 *
 * This runs before the base sanitizeGraph/autoFixGraph/normalizeGraph pipeline,
 * handling concerns that pipeline does not cover: malformed IDs, numeric complexity,
 * edge reference rewriting after ID correction, and edge deduplication.
 */
export declare function normalizeBatchOutput(data: {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
}): NormalizeBatchResult;
//# sourceMappingURL=normalize-graph.d.ts.map