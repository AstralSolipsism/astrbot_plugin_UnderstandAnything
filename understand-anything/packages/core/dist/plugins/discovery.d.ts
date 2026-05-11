export interface PluginEntry {
    name: string;
    enabled: boolean;
    languages: string[];
    options?: Record<string, unknown>;
}
export interface PluginConfig {
    plugins: PluginEntry[];
}
export declare const DEFAULT_PLUGIN_CONFIG: PluginConfig;
/**
 * Parse a plugin config JSON string.
 * Returns DEFAULT_PLUGIN_CONFIG if parsing fails.
 */
export declare function parsePluginConfig(jsonString: string): PluginConfig;
/**
 * Serialize a plugin config to JSON for saving.
 */
export declare function serializePluginConfig(config: PluginConfig): string;
//# sourceMappingURL=discovery.d.ts.map