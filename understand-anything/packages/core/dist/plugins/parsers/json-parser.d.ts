import type { AnalyzerPlugin, StructuralAnalysis, ReferenceResolution } from "../../types.js";
/**
 * Strip JSONC syntax (line comments, block comments, trailing commas) so the
 * result can be passed to the standard `JSON.parse`. Preserves string contents
 * verbatim — comment-like sequences inside strings are not removed.
 *
 * Plain JSON passes through unchanged (no `//`, `/* *​/`, or trailing commas
 * to remove).
 */
export declare function stripJsoncSyntax(content: string): string;
/**
 * Parses JSON / JSONC configuration files to extract top-level key sections and $ref references.
 * Handles package.json, tsconfig.json, wrangler.jsonc, JSON Schema, and OpenAPI spec files.
 * Does not descend into nested object structures beyond top-level keys.
 *
 * JSONC support: line comments (`// ...`), block comments (`/* ... *​/`), and
 * trailing commas are stripped before `JSON.parse`. Strings are preserved.
 */
export declare class JSONConfigParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    extractReferences(filePath: string, content: string): ReferenceResolution[];
    private extractSections;
}
//# sourceMappingURL=json-parser.d.ts.map