export {
  buildChatContext,
  formatContextForPrompt,
  type ChatContext,
} from "./context-builder.js";
import {
  preflightSourceInventory,
  validateProjectOutputs,
  type ValidateProjectOutputsOptions,
} from "./validation/output-pipeline.js";
import {
  buildAssistantContextBundle,
  type AssistantContextBundleActionPayload,
} from "./assistant-context.js";

export { buildChatPrompt } from "./understand-chat.js";
export {
  buildDiffContext,
  formatDiffAnalysis,
  type DiffContext,
} from "./diff-analyzer.js";
export {
  buildExplainContext,
  formatExplainPrompt,
  type ExplainContext,
} from "./explain-builder.js";
export { buildOnboardingGuide } from "./onboard-builder.js";

export {
  preflightSourceInventory,
  validateProjectOutputs,
  type OutputValidationObservation,
  type ValidateProjectOutputsOptions,
  type ValidateProjectOutputsResult,
} from "./validation/output-pipeline.js";
export {
  compileDomainGraph,
  normalizeDomainAnalysisIR,
  type DomainAnalysisIR,
} from "./validation/domain-analysis-ir.js";

export function preflightInventoryAction(options: {
  projectRoot: string;
  graphRoot: string;
  expectedGitCommitHash?: string;
}) {
  const result = preflightSourceInventory(options);
  return {
    ok: true,
    artifacts: result.artifacts,
    observations: result.observations,
    warnings: [],
  };
}

export function validateOutputsAction(options: ValidateProjectOutputsOptions) {
  return validateProjectOutputs(options);
}

export function compileDomainIrAction(options: Omit<ValidateProjectOutputsOptions, "jobKind"> & { jobKind?: string }) {
  return validateProjectOutputs({
    ...options,
    jobKind: options.jobKind ?? "understand-domain",
  });
}

export function assistantContextBundleAction(payload: AssistantContextBundleActionPayload) {
  return buildAssistantContextBundle(payload);
}
