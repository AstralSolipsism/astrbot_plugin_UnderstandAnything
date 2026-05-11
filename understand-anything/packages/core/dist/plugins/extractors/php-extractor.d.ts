import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
/**
 * PHP extractor for tree-sitter structural analysis and call graph extraction.
 *
 * Handles functions, classes, interfaces, use imports, and call graphs
 * for PHP source code parsed by tree-sitter-php.
 *
 * PHP-specific mapping decisions:
 * - `function_definition` nodes map to the `functions` array.
 * - `class_declaration` and `interface_declaration` map to the `classes` array.
 * - `property_declaration` nodes within classes map to class properties.
 * - `namespace_use_declaration` nodes (PHP `use` statements) map to imports.
 * - PHP has no formal export syntax, so public classes, interfaces, and
 *   top-level functions are treated as exports.
 * - Call graph covers `function_call_expression`, `member_call_expression`,
 *   and `scoped_call_expression`.
 */
export declare class PhpExtractor implements LanguageExtractor {
    readonly languageIds: string[];
    extractStructure(rootNode: TreeSitterNode): StructuralAnalysis;
    /**
     * Walk top-level statements, extracting functions, classes, interfaces, and imports.
     * Handles both direct children and declarations nested inside block-scoped
     * `namespace_definition` nodes (`namespace Foo { class Bar {} }`).
     */
    private walkStatements;
    extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[];
    private getFunctionName;
    private getClassName;
    private getInterfaceName;
    private extractFunction;
    private extractClass;
    private extractInterface;
    /**
     * Extract methods and properties from a class `declaration_list`.
     * Also pushes each method into the top-level functions array.
     */
    private extractDeclarationList;
    /**
     * Extract imports from a `namespace_use_declaration` node.
     *
     * Handles:
     * - Simple: `use App\Models\User;`
     * - Aliased: `use App\Contracts\Repository as Repo;`
     * - Grouped: `use App\Models\{User, Post};`
     */
    private extractUseDeclaration;
}
//# sourceMappingURL=php-extractor.d.ts.map