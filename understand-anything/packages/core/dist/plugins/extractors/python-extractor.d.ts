import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
/**
 * Python extractor for tree-sitter structural analysis and call graph extraction.
 *
 * Handles functions, classes, imports, exports, and call graphs for Python code.
 * Python has no formal export syntax, so all top-level function and class
 * definitions are treated as exports.
 */
export declare class PythonExtractor implements LanguageExtractor {
    readonly languageIds: string[];
    extractStructure(rootNode: TreeSitterNode): StructuralAnalysis;
    extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[];
    private extractFunction;
    private extractClass;
    private extractImport;
    private extractFromImport;
    private addExport;
}
//# sourceMappingURL=python-extractor.d.ts.map