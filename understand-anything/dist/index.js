export { buildChatContext, formatContextForPrompt, } from "./context-builder.js";
import { preflightSourceInventory, validateProjectOutputs, } from "./validation/output-pipeline.js";
import { buildAssistantContextBundle, } from "./assistant-context.js";
export { buildChatPrompt } from "./understand-chat.js";
export { buildDiffContext, formatDiffAnalysis, } from "./diff-analyzer.js";
export { buildExplainContext, formatExplainPrompt, } from "./explain-builder.js";
export { buildOnboardingGuide } from "./onboard-builder.js";
export { preflightSourceInventory, validateProjectOutputs, } from "./validation/output-pipeline.js";
export { compileDomainGraph, normalizeDomainAnalysisIR, } from "./validation/domain-analysis-ir.js";
export function preflightInventoryAction(options) {
    const result = preflightSourceInventory(options);
    return {
        ok: true,
        artifacts: result.artifacts,
        observations: result.observations,
        warnings: [],
    };
}
export function validateOutputsAction(options) {
    return validateProjectOutputs(options);
}
export function compileDomainIrAction(options) {
    return validateProjectOutputs({
        ...options,
        jobKind: options.jobKind ?? "understand-domain",
    });
}
export function assistantContextBundleAction(payload) {
    return buildAssistantContextBundle(payload);
}
//# sourceMappingURL=index.js.map