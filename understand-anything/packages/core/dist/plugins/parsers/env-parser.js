/**
 * Parses .env files to extract environment variable definitions.
 * Handles KEY=value syntax, skipping comments and empty lines.
 * Does not handle `export VAR=value` syntax or multi-line values.
 */
export class EnvParser {
    name = "env-parser";
    languages = ["env"];
    analyzeFile(_filePath, content) {
        const definitions = this.extractVariables(content);
        return {
            functions: [],
            classes: [],
            imports: [],
            exports: [],
            definitions,
        };
    }
    extractVariables(content) {
        const definitions = [];
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith("#") || line === "")
                continue;
            const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
            if (match) {
                definitions.push({
                    name: match[1],
                    kind: "variable",
                    lineRange: [i + 1, i + 1],
                    fields: [],
                });
            }
        }
        return definitions;
    }
}
//# sourceMappingURL=env-parser.js.map