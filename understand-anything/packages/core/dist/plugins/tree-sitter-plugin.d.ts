import type { AnalyzerPlugin, StructuralAnalysis, ImportResolution, CallGraphEntry } from "../types.js";
import type { LanguageConfig } from "../languages/types.js";
import type { LanguageExtractor } from "./extractors/types.js";
/**
 * Config-driven tree-sitter plugin.
 *
 * Accepts LanguageConfig objects to determine which languages to support
 * and how to load their WASM grammars. Provides deep structural analysis
 * (functions, classes, imports, exports, call graphs) for all languages
 * with registered extractors: TypeScript, JavaScript, Python, Go, Rust,
 * Java, Ruby, PHP, C/C++, and C#.
 *
 * Languages without tree-sitter configs are gracefully skipped (the LLM
 * agent handles analysis for those).
 */
export declare class TreeSitterPlugin implements AnalyzerPlugin {
    readonly name = "tree-sitter";
    readonly languages: string[];
    private configs;
    private _ParserClass;
    private _languages;
    private _extensionToLang;
    private _initialized;
    private extractors;
    /**
     * Create a TreeSitterPlugin with the given language configs.
     * Only configs that have a `treeSitter` field will be loaded.
     * If no configs are provided, defaults to TypeScript and JavaScript.
     *
     * @param configs Language configurations to load
     * @param extractors Optional language extractors; if none provided, registers all builtin extractors
     */
    constructor(configs?: LanguageConfig[], extractors?: LanguageExtractor[]);
    registerExtractor(extractor: LanguageExtractor): void;
    private getExtractor;
    private languageKeyFromPath;
    /**
     * Initialize the plugin by loading the WASM module and all language grammars.
     * Must be called (and awaited) before any synchronous methods.
     */
    init(): Promise<void>;
    /**
     * Create a parser set to the appropriate language for the given file.
     * This is synchronous because all languages are pre-loaded during init().
     */
    private getParser;
    analyzeFile(filePath: string, content: string): StructuralAnalysis;
    resolveImports(filePath: string, content: string): ImportResolution[];
    extractCallGraph(filePath: string, content: string): CallGraphEntry[];
}
//# sourceMappingURL=tree-sitter-plugin.d.ts.map