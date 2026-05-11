export interface LLMFileAnalysis {
    fileSummary: string;
    tags: string[];
    complexity: "simple" | "moderate" | "complex";
    functionSummaries: Record<string, string>;
    classSummaries: Record<string, string>;
    languageNotes?: string;
}
export interface LLMProjectSummary {
    description: string;
    frameworks: string[];
    layers: Array<{
        name: string;
        description: string;
        filePatterns: string[];
    }>;
}
/**
 * Generates a prompt for analyzing a single source file with an LLM.
 */
export declare function buildFileAnalysisPrompt(filePath: string, content: string, projectContext: string): string;
/**
 * Generates a prompt for creating a project-level summary with an LLM.
 */
export declare function buildProjectSummaryPrompt(fileList: string[], sampleFiles: Array<{
    path: string;
    content: string;
}>): string;
/**
 * Parses an LLM response for file analysis. Returns null if parsing fails.
 */
export declare function parseFileAnalysisResponse(response: string): LLMFileAnalysis | null;
/**
 * Parses an LLM response for project summary. Returns null if parsing fails.
 */
export declare function parseProjectSummaryResponse(response: string): LLMProjectSummary | null;
//# sourceMappingURL=llm-analyzer.d.ts.map