import type { LanguageConfig } from "./types.js";
/**
 * Registry for language configurations. Maps language ids and file extensions
 * to their corresponding LanguageConfig objects.
 */
export declare class LanguageRegistry {
    private byId;
    private byExtension;
    private byFilename;
    register(config: LanguageConfig): void;
    getById(id: string): LanguageConfig | null;
    getByExtension(ext: string): LanguageConfig | null;
    getForFile(filePath: string): LanguageConfig | null;
    getAllLanguages(): LanguageConfig[];
    /**
     * Create a registry pre-populated with all built-in language configs.
     */
    static createDefault(): LanguageRegistry;
}
//# sourceMappingURL=language-registry.d.ts.map