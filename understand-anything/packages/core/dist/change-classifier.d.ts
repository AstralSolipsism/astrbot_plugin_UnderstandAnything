import type { ChangeAnalysis } from "./fingerprint.js";
export interface UpdateDecision {
    action: "SKIP" | "PARTIAL_UPDATE" | "ARCHITECTURE_UPDATE" | "FULL_UPDATE";
    filesToReanalyze: string[];
    rerunArchitecture: boolean;
    rerunTour: boolean;
    reason: string;
}
/**
 * Classify the type of graph update needed based on structural change analysis.
 *
 * Decision matrix:
 * - SKIP: all files NONE or COSMETIC only
 * - PARTIAL_UPDATE: some STRUCTURAL, same directories
 * - ARCHITECTURE_UPDATE: new/deleted directories or >10 structural files
 * - FULL_UPDATE: >30 structural files or >50% of total files changed structurally
 */
export declare function classifyUpdate(analysis: ChangeAnalysis, totalFilesInGraph: number, allKnownFiles?: string[]): UpdateDecision;
//# sourceMappingURL=change-classifier.d.ts.map