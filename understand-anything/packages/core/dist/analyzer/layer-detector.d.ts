import type { KnowledgeGraph, Layer } from "../types.js";
/**
 * LLM layer response structure — what the LLM returns for each layer.
 */
export interface LLMLayerResponse {
    name: string;
    description: string;
    filePatterns: string[];
}
/**
 * Heuristic layer detection — assigns file nodes to layers based on
 * directory path patterns. Unmatched files go to a "Core" layer.
 *
 * Only FILE-type nodes are assigned to layers.
 */
export declare function detectLayers(graph: KnowledgeGraph): Layer[];
/**
 * Builds an LLM prompt that asks the model to identify logical layers
 * from a list of file paths in the knowledge graph.
 */
export declare function buildLayerDetectionPrompt(graph: KnowledgeGraph): string;
/**
 * Parses an LLM response for layer detection.
 * Handles markdown code fences and raw JSON.
 * Returns the parsed array or null on failure.
 */
export declare function parseLayerDetectionResponse(response: string): LLMLayerResponse[] | null;
/**
 * Applies LLM-provided layer definitions to a knowledge graph.
 * Matches file nodes against LLM filePatterns (path prefix matching).
 * Unassigned file nodes go to an "Other" layer.
 */
export declare function applyLLMLayers(graph: KnowledgeGraph, llmLayers: LLMLayerResponse[]): Layer[];
//# sourceMappingURL=layer-detector.d.ts.map