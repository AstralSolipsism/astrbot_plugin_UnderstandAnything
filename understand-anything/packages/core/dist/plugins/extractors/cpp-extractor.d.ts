import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
/**
 * C/C++ extractor for tree-sitter structural analysis and call graph extraction.
 *
 * Handles:
 * - Free functions (function_definition)
 * - Classes (class_specifier) with methods, properties, and access specifiers
 * - Structs (struct_specifier) with fields
 * - #include directives mapped to imports
 * - Namespaces (namespace_definition) with recursive traversal
 * - Out-of-class method definitions (e.g., void Server::start())
 * - Call graph extraction from call_expression nodes
 *
 * C/C++ has no formal export syntax. Non-static top-level functions and
 * public class/struct members are treated as exports.
 */
export declare class CppExtractor implements LanguageExtractor {
    readonly languageIds: string[];
    extractStructure(rootNode: TreeSitterNode): StructuralAnalysis;
    extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[];
    /**
     * Walk top-level declarations. Recurses into namespace_definition bodies
     * to find nested declarations.
     */
    private walkTopLevel;
    /**
     * Extract the simple function name from a function_definition.
     * For qualified names (e.g., Server::start), returns just the method name.
     */
    private extractFunctionName;
    /**
     * Extract #include directives and map them to the imports array.
     *
     * `preproc_include` has a `path` field that is either:
     * - `system_lib_string` for angle-bracket includes: `<iostream>`
     * - `string_literal` for quoted includes: `"myfile.h"`
     */
    private extractInclude;
    /**
     * Extract class_specifier or struct_specifier into the classes array.
     *
     * Processes:
     * - Properties (field_declaration without function_declarator)
     * - Method declarations (field_declaration with function_declarator)
     * - Method definitions (function_definition inside the class body)
     * - Access specifiers (public/private/protected)
     *
     * Public members of classes and all members of structs (default public)
     * are treated as exports.
     */
    private extractClassOrStruct;
    /**
     * Extract a free function or out-of-class method definition.
     *
     * For qualified names (e.g., `void Server::start()`), the method is:
     * - Added to the functions array
     * - Tracked in methodsByClass for later association with the class
     * - Exported if non-static
     *
     * Static functions are NOT exported.
     */
    private extractFunctionDef;
    /**
     * Extract the callee name from a call_expression.
     *
     * Handles:
     * - Plain function call: `printf(...)` -> "printf"
     * - Member call via field_expression: `p->method()` -> "p->method"
     * - Scoped call: `std::cout << ...` -> qualified name text
     */
    private extractCalleeName;
}
//# sourceMappingURL=cpp-extractor.d.ts.map