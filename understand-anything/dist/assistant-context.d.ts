import { buildDiffOverlay, type AssistantContextItem, type AssistantMode, type SourceSnippet } from "@understand-anything/assistant";
import type { KnowledgeGraph } from "@understand-anything/core/types";
export interface AssistantContextBundleActionPayload {
    projectRoot: string;
    graphRoot: string;
    mode?: string;
    messages?: unknown;
    items?: unknown;
    contextItems?: unknown;
    changedFiles?: unknown;
    gitCommitHash?: string;
    graphHash?: string;
}
export interface AssistantContextBundleActionResult {
    ok: boolean;
    artifacts: string[];
    observations: unknown[];
    warnings: string[];
    prompt: string;
    context: {
        mode: AssistantMode;
        items: AssistantContextItem[];
        sourceSnippets: SourceSnippet[];
        graphSummary: {
            project: KnowledgeGraph["project"];
            nodeCount: number;
            edgeCount: number;
            layerCount: number;
            domainNodeCount: number;
            domainEdgeCount: number;
        };
        diffOverlay?: ReturnType<typeof buildDiffOverlay>;
        onboardingDraft?: string;
    };
}
export declare function buildAssistantContextBundle(payload: AssistantContextBundleActionPayload): AssistantContextBundleActionResult;
//# sourceMappingURL=assistant-context.d.ts.map