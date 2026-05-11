import type { StructuralAnalysis } from "./types.js";
import type { PluginRegistry } from "./plugins/registry.js";
export interface FunctionFingerprint {
    name: string;
    params: string[];
    returnType?: string;
    exported: boolean;
    lineCount: number;
}
export interface ClassFingerprint {
    name: string;
    methods: string[];
    properties: string[];
    exported: boolean;
    lineCount: number;
}
export interface ImportFingerprint {
    source: string;
    specifiers: string[];
}
export interface FileFingerprint {
    filePath: string;
    contentHash: string;
    functions: FunctionFingerprint[];
    classes: ClassFingerprint[];
    imports: ImportFingerprint[];
    exports: string[];
    totalLines: number;
    hasStructuralAnalysis: boolean;
}
export interface FingerprintStore {
    version: "1.0.0";
    gitCommitHash: string;
    generatedAt: string;
    files: Record<string, FileFingerprint>;
}
export type ChangeLevel = "NONE" | "COSMETIC" | "STRUCTURAL";
export interface FileChangeResult {
    filePath: string;
    changeLevel: ChangeLevel;
    details: string[];
}
export interface ChangeAnalysis {
    fileChanges: FileChangeResult[];
    newFiles: string[];
    deletedFiles: string[];
    structurallyChangedFiles: string[];
    cosmeticOnlyFiles: string[];
    unchangedFiles: string[];
}
/**
 * Compute SHA-256 content hash for a file's content.
 */
export declare function contentHash(content: string): string;
/**
 * Extract a structural fingerprint from a file using its tree-sitter analysis.
 * The fingerprint captures only the elements that affect the knowledge graph
 * (function/class/import/export signatures), not implementation details.
 */
export declare function extractFileFingerprint(filePath: string, content: string, analysis: StructuralAnalysis): FileFingerprint;
/**
 * Compare two file fingerprints and determine the change level.
 *
 * - NONE: content hash identical (file unchanged)
 * - COSMETIC: content differs but structural signatures match (internal logic only)
 * - STRUCTURAL: signature-level changes detected
 */
export declare function compareFingerprints(oldFp: FileFingerprint, newFp: FileFingerprint): FileChangeResult;
/**
 * Build a fingerprint store for a set of files.
 * Files without tree-sitter support get content-hash-only fingerprints
 * (conservative: any change is treated as STRUCTURAL).
 */
export declare function buildFingerprintStore(projectDir: string, filePaths: string[], registry: PluginRegistry, gitCommitHash: string): FingerprintStore;
/**
 * Analyze changes between the current state of files and stored fingerprints.
 * Returns a detailed breakdown of what changed and at what level.
 */
export declare function analyzeChanges(projectDir: string, changedFiles: string[], existingStore: FingerprintStore, registry: PluginRegistry): ChangeAnalysis;
//# sourceMappingURL=fingerprint.d.ts.map