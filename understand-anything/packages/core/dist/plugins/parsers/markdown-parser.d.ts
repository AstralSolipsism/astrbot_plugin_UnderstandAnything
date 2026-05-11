import type { AnalyzerPlugin, StructuralAnalysis, ReferenceResolution } from "../../types.js";
/**
 * Parses Markdown files to extract heading sections and local file/image references.
 * Supports ATX-style headings (# through ######) with line range computation.
 * Does not extract code blocks, front matter fields, or external URL references.
 */
export declare class MarkdownParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    extractReferences(filePath: string, content: string): ReferenceResolution[];
    private extractSections;
}
//# sourceMappingURL=markdown-parser.d.ts.map