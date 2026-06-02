import { type QualityReport, type SourceInventory } from "./quality.js";
export type OutputValidationJobKind = "understand" | "understand-domain" | "understand-knowledge" | string;
export type OutputValidationObservationLevel = "info" | "success" | "warning" | "error";
export interface OutputValidationObservation {
    kind: "stage" | "validation" | "quality" | "artifact" | "warning" | "error" | "system";
    level: OutputValidationObservationLevel;
    title: string;
    message: string;
    stage: "source" | "validate" | "complete";
    status: "running" | "succeeded" | "failed";
    details?: Record<string, unknown>;
}
export interface ValidateProjectOutputsOptions {
    projectRoot: string;
    graphRoot: string;
    jobId: string;
    jobKind: OutputValidationJobKind;
    locale?: string;
    expectedGitCommitHash?: string;
    strictVisibleLanguage?: "auto" | "zh" | "none" | boolean;
}
export interface ValidateProjectOutputsResult {
    ok: boolean;
    artifacts: string[];
    observations: OutputValidationObservation[];
    quality?: QualityReport;
    fatal?: string;
    warnings: string[];
}
export declare function preflightSourceInventory(options: {
    projectRoot: string;
    graphRoot: string;
    expectedGitCommitHash?: string;
}): {
    inventory: SourceInventory;
    artifacts: string[];
    observations: OutputValidationObservation[];
};
export declare function validateProjectOutputs(options: ValidateProjectOutputsOptions): ValidateProjectOutputsResult;
//# sourceMappingURL=output-pipeline.d.ts.map