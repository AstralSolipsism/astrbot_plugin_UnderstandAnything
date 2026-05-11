import type { AnalyzerPlugin, StructuralAnalysis } from "../../types.js";
/**
 * Parses Terraform (.tf) files to extract resource, data, module, variable, and output blocks.
 * Handles HCL block syntax with brace-matching for line range computation.
 * Does not handle provider blocks, locals, or terraform configuration blocks.
 */
export declare class TerraformParser implements AnalyzerPlugin {
    name: string;
    languages: string[];
    analyzeFile(_filePath: string, content: string): StructuralAnalysis;
    private extractResources;
    private extractVariablesAndOutputs;
    private findClosingBrace;
}
//# sourceMappingURL=terraform-parser.d.ts.map