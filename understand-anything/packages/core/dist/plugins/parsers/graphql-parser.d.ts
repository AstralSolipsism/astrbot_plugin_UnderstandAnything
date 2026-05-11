import type { AnalyzerPlugin, StructuralAnalysis } from "../../types.js";
/**
 * Parses GraphQL schema files to extract type, input, enum, interface, union, and scalar definitions.
 * Extracts Query, Mutation, and Subscription endpoints as separate endpoint entries.
 * Does not handle schema directives, fragments, or inline union members.
 */
export declare class GraphQLParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    private extractDefinitions;
    private extractEndpoints;
    private extractFields;
}
//# sourceMappingURL=graphql-parser.d.ts.map