import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
/**
 * C# extractor for tree-sitter structural analysis and call graph extraction.
 *
 * Handles classes, interfaces, methods, constructors, properties, fields,
 * using directives, visibility-based exports, and call graphs for C# source code.
 *
 * C#-specific mapping decisions:
 * - Classes and interfaces are mapped to the `classes` array.
 * - Constructors are mapped to the `functions` array (named after the class).
 * - Methods (including interface method signatures) are listed in the
 *   containing class/interface's `methods` array and also in the `functions` array.
 * - Properties (e.g., `public string Name { get; set; }`) are extracted into
 *   the containing class's `properties` array alongside fields.
 * - Exports are determined by the `public` modifier on classes, interfaces,
 *   methods, constructors, properties, and fields.
 * - Namespaces: both block-scoped (`namespace Foo { ... }`) and file-scoped
 *   (`namespace Foo;`) are traversed to find declarations.
 * - Using directives are mapped to imports, with the last dotted component
 *   as the specifier.
 */
export declare class CSharpExtractor implements LanguageExtractor {
    readonly languageIds: string[];
    extractStructure(rootNode: TreeSitterNode): StructuralAnalysis;
    extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[];
    /**
     * Walk the top-level nodes of a compilation_unit, recursing into
     * namespace bodies to find declarations.
     */
    private walkTopLevel;
    /**
     * Walk into a namespace_declaration's body (declaration_list) to find
     * classes, interfaces, and nested namespaces.
     */
    private walkNamespaceBody;
    private extractUsing;
    private extractClass;
    private extractInterface;
    /**
     * Extract methods, constructors, properties, and fields from a
     * class declaration_list body.
     */
    private extractClassBodyMembers;
    private extractMethod;
    private extractConstructor;
    private extractProperty;
    private extractField;
}
//# sourceMappingURL=csharp-extractor.d.ts.map