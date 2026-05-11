import type { AnalyzerPlugin, StructuralAnalysis, ReferenceResolution } from "../../types.js";
/**
 * Parses shell scripts (.sh, .bash) to extract function definitions and source references.
 * Handles both `name() {` and `function name {` styles, including brace on next line.
 * Does not extract variable declarations, aliases, or trap handlers.
 */
export declare class ShellParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    extractReferences(filePath: string, content: string): ReferenceResolution[];
    private extractFunctions;
}
//# sourceMappingURL=shell-parser.d.ts.map