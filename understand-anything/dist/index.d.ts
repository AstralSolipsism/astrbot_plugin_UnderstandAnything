export { buildChatContext, formatContextForPrompt, type ChatContext, } from "./context-builder.js";
import { type ValidateProjectOutputsOptions } from "./validation/output-pipeline.js";
import { type AssistantContextBundleActionPayload } from "./assistant-context.js";
export { buildChatPrompt } from "./understand-chat.js";
export { buildDiffContext, formatDiffAnalysis, type DiffContext, } from "./diff-analyzer.js";
export { buildExplainContext, formatExplainPrompt, type ExplainContext, } from "./explain-builder.js";
export { buildOnboardingGuide } from "./onboard-builder.js";
export { preflightSourceInventory, validateProjectOutputs, type OutputValidationObservation, type ValidateProjectOutputsOptions, type ValidateProjectOutputsResult, } from "./validation/output-pipeline.js";
export { compileDomainGraph, normalizeDomainAnalysisIR, type DomainAnalysisIR, } from "./validation/domain-analysis-ir.js";
export declare function preflightInventoryAction(options: {
    projectRoot: string;
    graphRoot: string;
    expectedGitCommitHash?: string;
}): {
    ok: boolean;
    artifacts: string[];
    observations: import("./index.js").OutputValidationObservation[];
    warnings: never[];
};
export declare function validateOutputsAction(options: ValidateProjectOutputsOptions): import("./index.js").ValidateProjectOutputsResult;
export declare function compileDomainIrAction(options: Omit<ValidateProjectOutputsOptions, "jobKind"> & {
    jobKind?: string;
}): import("./index.js").ValidateProjectOutputsResult;
export declare function assistantContextBundleAction(payload: AssistantContextBundleActionPayload): import("./assistant-context.js").AssistantContextBundleActionResult;
//# sourceMappingURL=index.d.ts.map