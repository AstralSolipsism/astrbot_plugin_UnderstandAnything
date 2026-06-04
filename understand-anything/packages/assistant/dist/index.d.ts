import type { GraphEdge, GraphNode, KnowledgeGraph, Layer } from "@understand-anything/core/types";
export type AssistantMode = "chat" | "explain" | "diff" | "onboarding";
export type AssistantContextItem = {
    type: "node";
    nodeId: string;
    label: string;
    filePath?: string;
    graphKind?: "knowledge" | "domain";
} | {
    type: "file";
    path: string;
    label: string;
    nodeId?: string;
    graphKind?: "knowledge" | "domain";
} | {
    type: "code-range";
    path: string;
    startLine: number;
    endLine: number;
    label: string;
    nodeId?: string;
    graphKind?: "knowledge" | "domain";
} | {
    type: "diff-file";
    path: string;
    status?: "added" | "modified" | "deleted" | "renamed";
    label: string;
    nodeId?: string;
    graphKind?: "knowledge" | "domain";
} | {
    type: "layer";
    layerId: string;
    label: string;
};
export interface SourceSnippet {
    path: string;
    language: string;
    content: string;
    startLine?: number;
    endLine?: number;
    truncated?: boolean;
}
export interface AssistantPromptMessage {
    role: "user" | "assistant";
    content: string;
}
export interface DiffContext {
    projectName: string;
    changedFiles: string[];
    changedNodes: GraphNode[];
    affectedNodes: GraphNode[];
    impactedEdges: GraphEdge[];
    affectedLayers: Layer[];
    unmappedFiles: string[];
}
export interface ExplainContext {
    projectName: string;
    target: string;
    targetNode: GraphNode | null;
    childNodes: GraphNode[];
    connectedNodes: GraphNode[];
    relevantEdges: GraphEdge[];
    layer: Layer | null;
}
export interface BuildAssistantPromptOptions {
    mode: AssistantMode;
    graph: KnowledgeGraph;
    domainGraph?: KnowledgeGraph | null;
    messages: AssistantPromptMessage[];
    contextItems: AssistantContextItem[];
    sourceSnippets: SourceSnippet[];
    diffContext?: DiffContext | null;
    onboardingDraft?: string | null;
    gitCommitHash?: string;
    graphHash?: string;
}
export declare function buildChatContext(graph: KnowledgeGraph, query: string, maxNodes?: number): {
    relevantNodes: GraphNode[];
    relevantEdges: GraphEdge[];
    relevantLayers: Layer[];
};
export declare function buildExplainContext(graph: KnowledgeGraph, target: string): ExplainContext;
export declare function buildDiffContext(graph: KnowledgeGraph, changedFiles: string[]): DiffContext;
export declare function buildDiffOverlay(context: DiffContext): {
    changedNodeIds: string[];
    affectedNodeIds: string[];
    changedEdges: GraphEdge[];
    changedFiles: string[];
    unmappedFiles: string[];
};
export declare function buildOnboardingGuide(graph: KnowledgeGraph): string;
export declare function buildAssistantPrompt(options: BuildAssistantPromptOptions): string;
//# sourceMappingURL=index.d.ts.map