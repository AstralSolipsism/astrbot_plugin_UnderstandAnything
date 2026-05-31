import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, isAbsolute, relative, basename } from "node:path";
import { validateGraph } from "../schema.js";
const UA_DIR = ".understand-anything";
const GRAPH_FILE = "knowledge-graph.json";
const META_FILE = "meta.json";
const FINGERPRINT_FILE = "fingerprints.json";
const CONFIG_FILE = "config.json";
function ensureDir(projectRoot) {
    const dir = join(projectRoot, UA_DIR);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}
function ensureGraphDir(projectRoot, options) {
    if (options?.graphRoot) {
        mkdirSync(options.graphRoot, { recursive: true });
        return options.graphRoot;
    }
    return ensureDir(projectRoot);
}
function graphFilePath(projectRoot, fileName, options) {
    return join(options?.graphRoot ?? join(projectRoot, UA_DIR), fileName);
}
/**
 * Sanitise every node's filePath before writing to disk.
 *
 * The analysis agent produces absolute paths like:
 *   /Users/alice/company/src/auth.ts
 *
 * We convert them to paths relative to projectRoot:
 *   src/auth.ts
 *
 * Three cases are handled:
 *   1. Path is inside projectRoot      → make it relative
 *   2. Path is absolute but outside    → keep only the filename (last segment)
 *   3. Path is already relative        → leave it untouched
 *
 * This means the developer's home directory, username, and company
 * directory layout are never written to knowledge-graph.json.
 */
function sanitiseFilePaths(graph, projectRoot) {
    const normalRoot = projectRoot.endsWith("/")
        ? projectRoot
        : projectRoot + "/";
    const sanitisedNodes = graph.nodes.map((node) => {
        if (typeof node.filePath !== "string")
            return node;
        const fp = node.filePath;
        if (!isAbsolute(fp)) {
            // Already relative — nothing to do.
            return node;
        }
        if (fp.startsWith(normalRoot) || fp.startsWith(projectRoot)) {
            // Inside the project root — make it relative.
            return { ...node, filePath: relative(projectRoot, fp) };
        }
        // Absolute but outside the project root — use only the filename
        // so we leak as little as possible.
        return { ...node, filePath: basename(fp) };
    });
    return { ...graph, nodes: sanitisedNodes };
}
export function saveGraph(projectRoot, graph) {
    const dir = ensureDir(projectRoot);
    // FIX — sanitise absolute file paths before persisting.
    // Without this, absolute paths like /Users/alice/company/src/auth.ts
    // are written verbatim into knowledge-graph.json and later served
    // by the dashboard server, leaking the developer's directory layout.
    const sanitised = sanitiseFilePaths(graph, projectRoot);
    writeFileSync(join(dir, GRAPH_FILE), JSON.stringify(sanitised, null, 2), "utf-8");
}
export function loadGraph(projectRoot, options) {
    const filePath = join(projectRoot, UA_DIR, GRAPH_FILE);
    if (!existsSync(filePath))
        return null;
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (options?.validate !== false) {
        const result = validateGraph(data);
        if (!result.success) {
            throw new Error(`Invalid knowledge graph: ${result.fatal ?? "unknown error"}`);
        }
        return result.data;
    }
    return data;
}
export function saveMeta(projectRoot, meta) {
    const dir = ensureDir(projectRoot);
    writeFileSync(join(dir, META_FILE), JSON.stringify(meta, null, 2), "utf-8");
}
export function loadMeta(projectRoot) {
    const filePath = join(projectRoot, UA_DIR, META_FILE);
    if (!existsSync(filePath))
        return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
}
export function saveFingerprints(projectRoot, store, options) {
    const dir = ensureGraphDir(projectRoot, options);
    writeFileSync(join(dir, FINGERPRINT_FILE), JSON.stringify(store, null, 2), "utf-8");
}
export function loadFingerprints(projectRoot, options) {
    const filePath = graphFilePath(projectRoot, FINGERPRINT_FILE, options);
    if (!existsSync(filePath))
        return null;
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    }
    catch {
        return null;
    }
}
const DEFAULT_CONFIG = { autoUpdate: false };
export function saveConfig(projectRoot, config) {
    const dir = ensureDir(projectRoot);
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2), "utf-8");
}
export function loadConfig(projectRoot) {
    const filePath = join(projectRoot, UA_DIR, CONFIG_FILE);
    if (!existsSync(filePath))
        return { ...DEFAULT_CONFIG };
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    }
    catch {
        return { ...DEFAULT_CONFIG };
    }
}
const DOMAIN_GRAPH_FILE = "domain-graph.json";
export function saveDomainGraph(projectRoot, graph) {
    const dir = ensureDir(projectRoot);
    const sanitised = sanitiseFilePaths(graph, projectRoot);
    writeFileSync(join(dir, DOMAIN_GRAPH_FILE), JSON.stringify(sanitised, null, 2), "utf-8");
}
export function loadDomainGraph(projectRoot, options) {
    const filePath = join(projectRoot, UA_DIR, DOMAIN_GRAPH_FILE);
    if (!existsSync(filePath))
        return null;
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (options?.validate !== false) {
        const result = validateGraph(data);
        if (!result.success) {
            throw new Error(`Invalid domain graph: ${result.fatal ?? "unknown error"}`);
        }
        return result.data;
    }
    return data;
}
//# sourceMappingURL=index.js.map