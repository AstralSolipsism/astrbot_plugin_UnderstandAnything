import type { AnalyzerPlugin, StructuralAnalysis, ImportResolution, CallGraphEntry } from "../types.js";
import { LanguageRegistry } from "../languages/language-registry.js";
/**
 * Registry for analyzer plugins. Maps languages to plugins and provides
 * a unified interface for analyzing files across languages.
 *
 * Uses LanguageRegistry for extension-to-language mapping instead of
 * a hardcoded lookup table.
 */
export declare class PluginRegistry {
    private plugins;
    private languageMap;
    private languageRegistry;
    constructor(languageRegistry?: LanguageRegistry);
    register(plugin: AnalyzerPlugin): void;
    unregister(name: string): void;
    getPluginForLanguage(language: string): AnalyzerPlugin | null;
    getPluginForFile(filePath: string): AnalyzerPlugin | null;
    /**
     * Get the language id for a file path using the language registry.
     */
    getLanguageForFile(filePath: string): string | null;
    analyzeFile(filePath: string, content: string): StructuralAnalysis | null;
    resolveImports(filePath: string, content: string): ImportResolution[] | null;
    extractCallGraph(filePath: string, content: string): CallGraphEntry[] | null;
    getPlugins(): AnalyzerPlugin[];
    getSupportedLanguages(): string[];
}
//# sourceMappingURL=registry.d.ts.map