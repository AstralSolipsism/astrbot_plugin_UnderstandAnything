import { FrameworkConfigSchema } from "./types.js";
import { builtinFrameworkConfigs } from "./frameworks/index.js";
/**
 * Registry for framework configurations. Provides detection of frameworks
 * from manifest file contents and lookup by id or language.
 */
export class FrameworkRegistry {
    byId = new Map();
    byLanguage = new Map();
    register(config) {
        const parsed = FrameworkConfigSchema.parse(config);
        // Prevent duplicate registration
        if (this.byId.has(parsed.id))
            return;
        this.byId.set(parsed.id, parsed);
        for (const lang of parsed.languages) {
            const existing = this.byLanguage.get(lang) ?? [];
            existing.push(parsed);
            this.byLanguage.set(lang, existing);
        }
    }
    getById(id) {
        return this.byId.get(id) ?? null;
    }
    getForLanguage(langId) {
        return [...(this.byLanguage.get(langId) ?? [])];
    }
    getAllFrameworks() {
        return [...this.byId.values()];
    }
    /**
     * Detect frameworks from manifest file contents.
     * @param manifests - Map of filename to file content (e.g., { "requirements.txt": "django==4.2\n..." })
     * @returns Array of detected FrameworkConfig objects
     */
    detectFrameworks(manifests) {
        const detected = new Set();
        const results = [];
        for (const config of this.byId.values()) {
            if (detected.has(config.id))
                continue;
            for (const manifestFile of config.manifestFiles) {
                // Match manifest entries by filename (basename match)
                const content = Object.entries(manifests).find(([key]) => key === manifestFile || key.endsWith(`/${manifestFile}`))?.[1];
                if (!content)
                    continue;
                const contentLower = content.toLowerCase();
                const found = config.detectionKeywords.some((keyword) => contentLower.includes(keyword.toLowerCase()));
                if (found) {
                    detected.add(config.id);
                    results.push(config);
                    break;
                }
            }
        }
        return results;
    }
    /**
     * Create a registry pre-populated with all built-in framework configs.
     */
    static createDefault() {
        const registry = new FrameworkRegistry();
        for (const config of builtinFrameworkConfigs) {
            registry.register(config);
        }
        return registry;
    }
}
//# sourceMappingURL=framework-registry.js.map