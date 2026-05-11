import type { AnalyzerPlugin, StructuralAnalysis } from "../../types.js";
/**
 * Parses SQL files to extract table, view, and index definitions.
 * Handles CREATE TABLE, CREATE VIEW, CREATE INDEX with IF NOT EXISTS and OR REPLACE variants.
 * Does not handle stored procedures, triggers, or schema-qualified names (e.g., public.users).
 */
export declare class SQLParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    private extractDefinitions;
    private extractColumns;
}
//# sourceMappingURL=sql-parser.d.ts.map