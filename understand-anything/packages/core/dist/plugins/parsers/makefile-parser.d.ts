import type { AnalyzerPlugin, StructuralAnalysis } from "../../types.js";
/**
 * Parses Makefiles to extract build targets and their line ranges.
 * Filters out special Make targets (e.g., .PHONY, .DEFAULT, .SUFFIXES) and variable assignments.
 * Does not parse target dependencies or recipe commands.
 */
export declare class MakefileParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    private extractTargets;
}
//# sourceMappingURL=makefile-parser.d.ts.map