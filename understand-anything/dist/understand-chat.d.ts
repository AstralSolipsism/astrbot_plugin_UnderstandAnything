import type { KnowledgeGraph } from "@understand-anything/core";
import { type PromptLanguageOptions } from "./language-options.js";
/**
 * Build a complete chat prompt by combining knowledge graph context
 * with a system instruction for answering codebase questions.
 */
export declare function buildChatPrompt(graph: KnowledgeGraph, query: string, options?: PromptLanguageOptions): string;
//# sourceMappingURL=understand-chat.d.ts.map