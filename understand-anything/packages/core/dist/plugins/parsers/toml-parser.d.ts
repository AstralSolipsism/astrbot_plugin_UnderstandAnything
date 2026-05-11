import type { AnalyzerPlugin, StructuralAnalysis } from "../../types.js";
/**
 * Parses TOML files to extract section headers ([section] and [[array-of-tables]]).
 * Computes section nesting level from dotted key paths (e.g., [tool.poetry] = level 2).
 * Does not parse individual key-value pairs within sections.
 */
export declare class TOMLParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    private extractSections;
}
//# sourceMappingURL=toml-parser.d.ts.map