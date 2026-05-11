import type { GraphNode, GraphEdge } from "../types.js";
import type { LanguageConfig } from "../languages/types.js";
export interface LanguageLessonResult {
    languageNotes: string;
    concepts: Array<{
        name: string;
        explanation: string;
    }>;
}
/**
 * Detects language concepts present in a graph node based on its tags, summary, and languageNotes.
 * When a LanguageConfig is provided, language-specific concepts are also detected.
 */
export declare function detectLanguageConcepts(node: GraphNode, language: string, langConfig?: LanguageConfig | null): string[];
/**
 * Get the display name for a language.
 * Uses LanguageConfig if provided, otherwise falls back to capitalization.
 */
export declare function getLanguageDisplayName(language: string, langConfig?: LanguageConfig | null): string;
/**
 * Builds a prompt that asks an LLM to produce a language-specific lesson for a given node.
 */
export declare function buildLanguageLessonPrompt(node: GraphNode, edges: GraphEdge[], language: string, langConfig?: LanguageConfig | null): string;
/**
 * Parses an LLM response for language lesson content.
 * Returns a safe default on parse failure.
 */
export declare function parseLanguageLessonResponse(response: string): LanguageLessonResult;
//# sourceMappingURL=language-lesson.d.ts.map