/**
 * Parses Protocol Buffer (.proto) files to extract message, enum, and service definitions.
 * Extracts message fields, enum values, and service RPC method endpoints.
 * Does not handle nested message types, oneof fields, or proto2 extensions.
 */
export class ProtobufParser {
    name = "protobuf-parser";
    languages = ["protobuf"];
    analyzeFile(_filePath, content) {
        const definitions = this.extractDefinitions(content);
        const endpoints = this.extractServiceMethods(content);
        return {
            functions: [],
            classes: [],
            imports: [],
            exports: [],
            definitions,
            endpoints,
        };
    }
    extractDefinitions(content) {
        const definitions = [];
        // Match message definitions
        const messageRegex = /^message\s+(\w+)\s*\{/gm;
        let match;
        while ((match = messageRegex.exec(content)) !== null) {
            const startLine = content.slice(0, match.index).split("\n").length;
            const fields = this.extractMessageFields(content, match.index);
            const afterMatch = content.slice(match.index);
            const closeBrace = this.findClosingBrace(afterMatch);
            const endLine = content.slice(0, match.index + closeBrace + 1).split("\n").length;
            definitions.push({
                name: match[1],
                kind: "message",
                lineRange: [startLine, endLine],
                fields,
            });
        }
        // Match enum definitions
        const enumRegex = /^enum\s+(\w+)\s*\{/gm;
        while ((match = enumRegex.exec(content)) !== null) {
            const startLine = content.slice(0, match.index).split("\n").length;
            const fields = this.extractEnumValues(content, match.index);
            const afterMatch = content.slice(match.index);
            const closeBrace = this.findClosingBrace(afterMatch);
            const endLine = content.slice(0, match.index + closeBrace + 1).split("\n").length;
            definitions.push({
                name: match[1],
                kind: "enum",
                lineRange: [startLine, endLine],
                fields,
            });
        }
        return definitions;
    }
    extractServiceMethods(content) {
        const endpoints = [];
        const serviceRegex = /^service\s+(\w+)\s*\{/gm;
        let match;
        while ((match = serviceRegex.exec(content)) !== null) {
            const serviceName = match[1];
            const startIdx = match.index + match[0].length;
            const afterService = content.slice(match.index);
            const closeBrace = this.findClosingBrace(afterService);
            const body = afterService.slice(match[0].length, closeBrace);
            const rpcRegex = /rpc\s+(\w+)\s*\(/g;
            let rpcMatch;
            while ((rpcMatch = rpcRegex.exec(body)) !== null) {
                const lineNum = content.slice(0, startIdx + rpcMatch.index).split("\n").length;
                endpoints.push({
                    method: "rpc",
                    path: `${serviceName}.${rpcMatch[1]}`,
                    lineRange: [lineNum, lineNum],
                });
            }
        }
        return endpoints;
    }
    extractMessageFields(content, startIdx) {
        const fields = [];
        const afterMsg = content.slice(startIdx);
        const openBrace = afterMsg.indexOf("{");
        if (openBrace === -1)
            return fields;
        const closeBrace = this.findClosingBrace(afterMsg);
        const body = afterMsg.slice(openBrace + 1, closeBrace);
        const fieldRegex = /^\s*(?:repeated\s+|optional\s+|required\s+|map<[^>]+>\s+)?\w+\s+(\w+)\s*=/gm;
        let match;
        while ((match = fieldRegex.exec(body)) !== null) {
            fields.push(match[1]);
        }
        return fields;
    }
    extractEnumValues(content, startIdx) {
        const values = [];
        const afterEnum = content.slice(startIdx);
        const openBrace = afterEnum.indexOf("{");
        if (openBrace === -1)
            return values;
        const closeBrace = this.findClosingBrace(afterEnum);
        const body = afterEnum.slice(openBrace + 1, closeBrace);
        const valueRegex = /^\s*(\w+)\s*=/gm;
        let match;
        while ((match = valueRegex.exec(body)) !== null) {
            values.push(match[1]);
        }
        return values;
    }
    findClosingBrace(content) {
        let depth = 0;
        for (let i = 0; i < content.length; i++) {
            if (content[i] === "{")
                depth++;
            if (content[i] === "}") {
                depth--;
                if (depth === 0)
                    return i;
            }
        }
        if (depth !== 0) {
            console.warn(`[protobuf-parser] Unbalanced braces detected (depth=${depth}), results may be incomplete`);
        }
        return content.length;
    }
}
//# sourceMappingURL=protobuf-parser.js.map