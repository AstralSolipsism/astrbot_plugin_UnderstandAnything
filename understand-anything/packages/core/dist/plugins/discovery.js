import { builtinLanguageConfigs } from "../languages/configs/index.js";
export const DEFAULT_PLUGIN_CONFIG = {
    plugins: [
        {
            name: "tree-sitter",
            enabled: true,
            languages: builtinLanguageConfigs
                .filter((c) => c.treeSitter)
                .map((c) => c.id),
        },
    ],
};
/**
 * Parse a plugin config JSON string.
 * Returns DEFAULT_PLUGIN_CONFIG if parsing fails.
 */
export function parsePluginConfig(jsonString) {
    if (!jsonString.trim())
        return { ...DEFAULT_PLUGIN_CONFIG };
    try {
        const parsed = JSON.parse(jsonString);
        if (!parsed || !Array.isArray(parsed.plugins)) {
            return { ...DEFAULT_PLUGIN_CONFIG };
        }
        const plugins = parsed.plugins
            .filter((entry) => {
            if (typeof entry !== "object" || entry === null)
                return false;
            const e = entry;
            return (typeof e.name === "string" &&
                e.name.length > 0 &&
                Array.isArray(e.languages) &&
                e.languages.length > 0);
        })
            .map((e) => ({
            name: e.name,
            enabled: typeof e.enabled === "boolean" ? e.enabled : true,
            languages: e.languages,
            ...(e.options ? { options: e.options } : {}),
        }));
        return { plugins };
    }
    catch {
        return { ...DEFAULT_PLUGIN_CONFIG };
    }
}
/**
 * Serialize a plugin config to JSON for saving.
 */
export function serializePluginConfig(config) {
    return JSON.stringify(config, null, 2);
}
//# sourceMappingURL=discovery.js.map