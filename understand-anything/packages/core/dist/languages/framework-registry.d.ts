import type { FrameworkConfig } from "./types.js";
/**
 * Registry for framework configurations. Provides detection of frameworks
 * from manifest file contents and lookup by id or language.
 */
export declare class FrameworkRegistry {
    private byId;
    private byLanguage;
    register(config: FrameworkConfig): void;
    getById(id: string): FrameworkConfig | null;
    getForLanguage(langId: string): FrameworkConfig[];
    getAllFrameworks(): FrameworkConfig[];
    /**
     * Detect frameworks from manifest file contents.
     * @param manifests - Map of filename to file content (e.g., { "requirements.txt": "django==4.2\n..." })
     * @returns Array of detected FrameworkConfig objects
     */
    detectFrameworks(manifests: Record<string, string>): FrameworkConfig[];
    /**
     * Create a registry pre-populated with all built-in framework configs.
     */
    static createDefault(): FrameworkRegistry;
}
//# sourceMappingURL=framework-registry.d.ts.map