import { z } from "zod";
export declare const TreeSitterConfigSchema: z.ZodObject<{
    wasmPackage: z.ZodString;
    wasmFile: z.ZodString;
}, z.core.$strip>;
export type TreeSitterConfig = z.infer<typeof TreeSitterConfigSchema>;
export declare const FilePatternConfigSchema: z.ZodObject<{
    entryPoints: z.ZodArray<z.ZodString>;
    barrels: z.ZodArray<z.ZodString>;
    tests: z.ZodArray<z.ZodString>;
    config: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type FilePatternConfig = z.infer<typeof FilePatternConfigSchema>;
export declare const LanguageConfigSchema: z.ZodObject<{
    id: z.ZodString;
    displayName: z.ZodString;
    extensions: z.ZodArray<z.ZodString>;
    filenames: z.ZodOptional<z.ZodArray<z.ZodString>>;
    treeSitter: z.ZodOptional<z.ZodObject<{
        wasmPackage: z.ZodString;
        wasmFile: z.ZodString;
    }, z.core.$strip>>;
    concepts: z.ZodArray<z.ZodString>;
    filePatterns: z.ZodObject<{
        entryPoints: z.ZodArray<z.ZodString>;
        barrels: z.ZodArray<z.ZodString>;
        tests: z.ZodArray<z.ZodString>;
        config: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type LanguageConfig = z.infer<typeof LanguageConfigSchema>;
/**
 * Strict schema with refinement: ensures at least one extension or filename
 * is provided so the config can actually be detected by the registry.
 * Use this for validating new/user-supplied configs (some builtin configs like
 * kubernetes/github-actions intentionally lack both and rely on future
 * content-based detection).
 */
export declare const StrictLanguageConfigSchema: z.ZodObject<{
    id: z.ZodString;
    displayName: z.ZodString;
    extensions: z.ZodArray<z.ZodString>;
    filenames: z.ZodOptional<z.ZodArray<z.ZodString>>;
    treeSitter: z.ZodOptional<z.ZodObject<{
        wasmPackage: z.ZodString;
        wasmFile: z.ZodString;
    }, z.core.$strip>>;
    concepts: z.ZodArray<z.ZodString>;
    filePatterns: z.ZodObject<{
        entryPoints: z.ZodArray<z.ZodString>;
        barrels: z.ZodArray<z.ZodString>;
        tests: z.ZodArray<z.ZodString>;
        config: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const FrameworkConfigSchema: z.ZodObject<{
    id: z.ZodString;
    displayName: z.ZodString;
    languages: z.ZodArray<z.ZodString>;
    detectionKeywords: z.ZodArray<z.ZodString>;
    manifestFiles: z.ZodArray<z.ZodString>;
    promptSnippetPath: z.ZodString;
    entryPoints: z.ZodOptional<z.ZodArray<z.ZodString>>;
    layerHints: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
export type FrameworkConfig = z.infer<typeof FrameworkConfigSchema>;
//# sourceMappingURL=types.d.ts.map