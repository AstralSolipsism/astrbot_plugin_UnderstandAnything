import type { AnalyzerPlugin, StructuralAnalysis } from "../../types.js";
/**
 * Parses Protocol Buffer (.proto) files to extract message, enum, and service definitions.
 * Extracts message fields, enum values, and service RPC method endpoints.
 * Does not handle nested message types, oneof fields, or proto2 extensions.
 */
export declare class ProtobufParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    private extractDefinitions;
    private extractServiceMethods;
    private extractMessageFields;
    private extractEnumValues;
    private findClosingBrace;
}
//# sourceMappingURL=protobuf-parser.d.ts.map