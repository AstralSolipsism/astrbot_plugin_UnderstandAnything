import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
/**
 * Rust extractor for tree-sitter structural analysis and call graph extraction.
 *
 * Handles functions, structs, enums, traits, impl blocks, use declarations,
 * visibility-based exports, and call graphs for Rust source code.
 *
 * Rust-specific mapping decisions:
 * - Structs, enums, and traits are mapped to the `classes` array.
 * - Methods inside `impl` blocks are stored as functions and also listed
 *   in the corresponding struct/enum's `methods` array.
 * - Trait method signatures (function_signature_item) are listed in the
 *   trait's `methods` array.
 * - Exports are determined by the `pub` visibility modifier.
 * - Enum variants are extracted as `properties` of the enum class entry.
 */
export declare class RustExtractor implements LanguageExtractor {
    readonly languageIds: string[];
    extractStructure(rootNode: TreeSitterNode): StructuralAnalysis;
    extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[];
    /**
     * Extract the callee name from a call_expression.
     *
     * Handles:
     * - Plain function call: `check_port(x)` -> "check_port"
     * - Method call via field_expression: `self.validate()` -> "self.validate"
     * - Scoped call: `Vec::new()` -> "Vec::new"
     */
    private extractCalleeName;
    private extractFunction;
    private extractStruct;
    private extractEnum;
    private extractTrait;
    private extractImpl;
    private extractUseDeclaration;
}
//# sourceMappingURL=rust-extractor.d.ts.map