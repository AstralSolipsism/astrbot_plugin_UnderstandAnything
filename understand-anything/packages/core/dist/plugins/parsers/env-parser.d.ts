import type { AnalyzerPlugin, StructuralAnalysis } from "../../types.js";
/**
 * Parses .env files to extract environment variable definitions.
 * Handles KEY=value syntax, skipping comments and empty lines.
 * Does not handle `export VAR=value` syntax or multi-line values.
 */
export declare class EnvParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    private extractVariables;
}
//# sourceMappingURL=env-parser.d.ts.map