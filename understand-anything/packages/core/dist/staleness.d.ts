import type { KnowledgeGraph, GraphNode, GraphEdge } from "./types.js";
export interface StalenessResult {
    stale: boolean;
    changedFiles: string[];
}
/**
 * Get the list of files that changed between a given commit and HEAD.
 * Returns an empty array if there are no changes or if git encounters an error.
 */
export declare function getChangedFiles(projectDir: string, lastCommitHash: string): string[];
/**
 * Check whether the knowledge graph is stale relative to the current HEAD.
 */
export declare function isStale(projectDir: string, lastCommitHash: string): StalenessResult;
/**
 * Merge new analysis results into an existing knowledge graph.
 *
 * 1. Remove old nodes belonging to changed files (matched by filePath).
 * 2. Remove old edges where the SOURCE or TARGET node belongs to a changed file.
 * 3. Add new nodes and edges.
 * 4. Update project.gitCommitHash and project.analyzedAt.
 * 5. Return the merged graph.
 */
export declare function mergeGraphUpdate(existingGraph: KnowledgeGraph, changedFilePaths: string[], newNodes: GraphNode[], newEdges: GraphEdge[], newCommitHash: string): KnowledgeGraph;
//# sourceMappingURL=staleness.d.ts.map