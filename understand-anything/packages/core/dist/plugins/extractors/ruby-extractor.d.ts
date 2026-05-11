import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
/**
 * Ruby extractor for tree-sitter structural analysis and call graph extraction.
 *
 * Handles methods, classes, modules, require imports, and call graphs
 * for Ruby source code.
 *
 * Ruby-specific mapping decisions:
 * - Both `class` and `module` nodes are mapped to the `classes` array.
 * - `singleton_method` (def self.foo) is prefixed with "self." in the name.
 * - `attr_accessor`/`attr_reader`/`attr_writer` define properties on classes.
 * - `require` and `require_relative` calls are mapped to imports.
 * - All top-level definitions (classes, modules, methods) are treated as exports,
 *   since Ruby has no formal export syntax.
 */
export declare class RubyExtractor implements LanguageExtractor {
    readonly languageIds: string[];
    extractStructure(rootNode: TreeSitterNode): StructuralAnalysis;
    extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[];
    private getMethodName;
    private getSingletonMethodName;
    private getClassName;
    private getModuleName;
    private extractMethod;
    private extractSingletonMethod;
    private extractClass;
    private extractModule;
    /**
     * Extract methods and properties from a class/module body_statement.
     * Also pushes each method into the top-level functions array.
     */
    private extractClassBody;
    /**
     * Handle top-level call nodes: extract require/require_relative as imports.
     */
    private extractTopLevelCall;
}
//# sourceMappingURL=ruby-extractor.d.ts.map