import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
/**
 * Go extractor for tree-sitter structural analysis and call graph extraction.
 *
 * Handles functions, methods, structs, interfaces, imports, exports, and
 * call graphs for Go source code.
 *
 * Go-specific mapping decisions:
 * - Structs and interfaces are mapped to the `classes` array.
 * - Methods (with receivers) are stored as functions and also listed
 *   in the corresponding struct's `methods` array.
 * - Exports are determined by Go's capitalization convention.
 */
export declare class GoExtractor implements LanguageExtractor {
    readonly languageIds: string[];
    extractStructure(rootNode: TreeSitterNode): StructuralAnalysis;
    extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[];
    private extractFunction;
    private extractMethod;
    private extractTypeDeclaration;
    private extractStruct;
    private extractInterface;
    private extractImportDeclaration;
    private extractImportSpec;
}
//# sourceMappingURL=go-extractor.d.ts.map