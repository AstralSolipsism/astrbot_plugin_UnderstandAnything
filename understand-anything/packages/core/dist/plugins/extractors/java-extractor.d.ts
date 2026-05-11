import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
/**
 * Java extractor for tree-sitter structural analysis and call graph extraction.
 *
 * Handles classes, interfaces, methods, constructors, fields, imports,
 * visibility-based exports, and call graphs for Java source code.
 *
 * Java-specific mapping decisions:
 * - Classes and interfaces are mapped to the `classes` array.
 * - Constructors are mapped to the `functions` array (named after the class).
 * - Methods (including interface method signatures) are listed in the
 *   containing class/interface's `methods` array and also in the `functions` array.
 * - Exports are determined by the `public` modifier on classes, methods,
 *   constructors, and fields.
 * - Fields are extracted as `properties` from `field_declaration` nodes.
 */
export declare class JavaExtractor implements LanguageExtractor {
    readonly languageIds: string[];
    extractStructure(rootNode: TreeSitterNode): StructuralAnalysis;
    extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[];
    /**
     * Extract the callee name from a method_invocation node.
     *
     * Handles:
     * - Plain method call: `fetchFromDb(limit)` -> "fetchFromDb"
     * - Qualified call: `System.out.println(msg)` -> "System.out.println"
     */
    private extractMethodInvocationName;
    private extractImport;
    private extractClass;
    private extractInterface;
    /**
     * Extract methods, constructors, and fields from a class_body node.
     */
    private extractClassBodyMembers;
    private extractMethod;
    private extractConstructor;
    private extractField;
}
//# sourceMappingURL=java-extractor.d.ts.map