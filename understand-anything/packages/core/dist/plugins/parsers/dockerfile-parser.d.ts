import type { AnalyzerPlugin, StructuralAnalysis } from "../../types.js";
/**
 * Parses Dockerfiles to extract multi-stage build stages, EXPOSE ports, and instruction steps.
 * Associates EXPOSE ports with the correct stage based on FROM directive ordering.
 * Does not parse ARG/ENV variable substitution or heredoc syntax.
 */
export declare class DockerfileParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    private extractStages;
    private extractSteps;
}
//# sourceMappingURL=dockerfile-parser.d.ts.map