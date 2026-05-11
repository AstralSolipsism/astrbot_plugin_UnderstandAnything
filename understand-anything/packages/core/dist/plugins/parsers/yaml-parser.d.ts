import type { AnalyzerPlugin, StructuralAnalysis } from "../../types.js";
/**
 * Parses YAML configuration files to extract top-level key sections.
 * Uses the `yaml` library for parsing with a regex fallback for malformed input.
 * Only extracts top-level keys; does not descend into nested structures.
 *
 * The `languages` array also lists YAML-flavored special formats
 * (`docker-compose`, `kubernetes`, `github-actions`, `openapi`) so files
 * the language-registry tags with those ids don't fall through to the
 * "no parser matched" branch and lose all structural extraction.
 */
export declare class YAMLConfigParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    private extractSections;
    private escapeRegex;
}
//# sourceMappingURL=yaml-parser.d.ts.map