import type { KnowledgeGraph, TourStep } from "../types.js";
/**
 * Builds an LLM prompt asking for a guided tour of the project.
 * Includes project metadata, node summaries, edges, and layer info.
 */
export declare function buildTourGenerationPrompt(graph: KnowledgeGraph): string;
/**
 * Parses an LLM response for tour generation.
 * Handles raw JSON and JSON wrapped in markdown code fences.
 * Filters out steps missing required fields.
 * Returns empty array if parsing fails.
 */
export declare function parseTourGenerationResponse(response: string): TourStep[];
/**
 * Generates a tour heuristically (without an LLM) using graph topology.
 *
 * Strategy:
 * 1. Separate concept nodes from code nodes
 * 2. Build adjacency info from edges
 * 3. Find entry points (nodes with 0 incoming edges)
 * 4. Topological sort (Kahn's algorithm)
 * 5. If layers exist: group by layer in topological order
 * 6. If no layers: batch by 3 nodes per step
 * 7. Add concept nodes as final "Key Concepts" step
 * 8. Assign sequential order numbers
 */
export declare function generateHeuristicTour(graph: KnowledgeGraph): TourStep[];
//# sourceMappingURL=tour-generator.d.ts.map