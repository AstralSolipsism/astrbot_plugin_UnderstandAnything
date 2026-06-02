import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildFingerprintStore, PluginRegistry, registerAllParsers, validateGraph, } from "@understand-anything/core";
import { compileDomainGraph, normalizeDomainAnalysisIR } from "./domain-analysis-ir.js";
import { buildQualityReport, buildSourceInventory, collectFingerprintCandidatePaths, repairAndAssessGraphQuality, validateChineseVisibleContent, } from "./quality.js";
const KNOWLEDGE_GRAPH_FILE = "knowledge-graph.json";
const DOMAIN_GRAPH_FILE = "domain-graph.json";
const DOMAIN_IR_FILE = "intermediate/domain-analysis.json";
const META_FILE = "meta.json";
const SOURCE_INVENTORY_FILE = "source-inventory.json";
const FINGERPRINTS_FILE = "fingerprints.json";
const QUALITY_REPORT_FILE = "quality-report.json";
const MAX_FINGERPRINT_FILE_BYTES = 1024 * 1024;
function observation(observations, item) {
    observations.push(item);
}
function readJsonFile(filePath) {
    return JSON.parse(readFileSync(filePath, "utf-8"));
}
function writeJsonFile(filePath, value) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
function graphFilePath(graphRoot, fileName) {
    return join(graphRoot, fileName);
}
function buildRegistry() {
    const registry = new PluginRegistry();
    registerAllParsers(registry);
    return registry;
}
function shouldValidateChinese(locale, strict) {
    if (strict === false || strict === "none")
        return false;
    if (strict === true || strict === "zh")
        return true;
    const normalized = (locale || "").toLowerCase();
    return normalized === "zh" || normalized.startsWith("zh-");
}
function issueMessages(issues) {
    return issues
        .filter((item) => item.level === "fatal" || item.level === "error")
        .map((item) => item.message || item.code);
}
function validateCoreGraph(fileName, raw) {
    const result = validateGraph(raw);
    if (!result.success || !result.data) {
        throw new Error(`Invalid ${fileName}: ${result.fatal ?? result.issues.map((item) => item.message).join("; ")}`);
    }
    return result.data;
}
function validateGitCommit(expected, meta, graph) {
    const actual = typeof meta.gitCommitHash === "string" && meta.gitCommitHash.trim()
        ? meta.gitCommitHash.trim()
        : graph.project.gitCommitHash;
    if (expected && actual !== expected) {
        throw new Error(`Invalid meta.json: gitCommitHash must match expected commit ${expected}.`);
    }
}
function buildFingerprints(projectRoot, inventory, graphResults, gitCommitHash) {
    const candidates = collectFingerprintCandidatePaths(inventory, graphResults.map((item) => item.graph), MAX_FINGERPRINT_FILE_BYTES);
    return buildFingerprintStore(projectRoot, candidates, buildRegistry(), gitCommitHash);
}
function hasFatalQuality(report) {
    return report.issueCounts.fatal > 0 || report.issueCounts.error > 0;
}
export function preflightSourceInventory(options) {
    const observations = [];
    mkdirSync(options.graphRoot, { recursive: true });
    const inventory = buildSourceInventory(options.projectRoot, {
        graphRoot: options.graphRoot,
        gitCommitHash: options.expectedGitCommitHash,
    });
    writeJsonFile(graphFilePath(options.graphRoot, SOURCE_INVENTORY_FILE), inventory);
    observation(observations, {
        kind: "artifact",
        level: "success",
        title: "源码清单已生成",
        message: `已记录 ${inventory.totals.files} 个文件和 ${inventory.totals.directories} 个目录。`,
        stage: "source",
        status: "succeeded",
        details: { fileCount: inventory.totals.files, directoryCount: inventory.totals.directories },
    });
    return { inventory, artifacts: [SOURCE_INVENTORY_FILE], observations };
}
export function validateProjectOutputs(options) {
    const observations = [];
    const artifacts = new Set();
    const warnings = [];
    try {
        mkdirSync(options.graphRoot, { recursive: true });
        observation(observations, {
            kind: "stage",
            level: "info",
            title: "开始校验分析产物",
            message: "正在校验图谱、源码清单、指纹和质量报告。",
            stage: "validate",
            status: "running",
        });
        const knowledgeGraphPath = graphFilePath(options.graphRoot, KNOWLEDGE_GRAPH_FILE);
        if (!existsSync(knowledgeGraphPath)) {
            throw new Error(`Missing required artifact: ${KNOWLEDGE_GRAPH_FILE}`);
        }
        const metaPath = graphFilePath(options.graphRoot, META_FILE);
        if (!existsSync(metaPath)) {
            throw new Error(`Missing required artifact: ${META_FILE}`);
        }
        const rawKnowledgeGraph = readJsonFile(knowledgeGraphPath);
        const meta = readJsonFile(metaPath);
        const knowledgeGraph = validateCoreGraph(KNOWLEDGE_GRAPH_FILE, rawKnowledgeGraph);
        validateGitCommit(options.expectedGitCommitHash, meta, knowledgeGraph);
        if (shouldValidateChinese(options.locale, options.strictVisibleLanguage)) {
            validateChineseVisibleContent(KNOWLEDGE_GRAPH_FILE, knowledgeGraph);
        }
        const inventoryResult = preflightSourceInventory({
            projectRoot: options.projectRoot,
            graphRoot: options.graphRoot,
            expectedGitCommitHash: options.expectedGitCommitHash ?? knowledgeGraph.project.gitCommitHash,
        });
        const inventory = inventoryResult.inventory;
        inventoryResult.artifacts.forEach((item) => artifacts.add(item));
        observations.push(...inventoryResult.observations);
        const graphResults = [];
        const knowledgeQuality = repairAndAssessGraphQuality(knowledgeGraph, "knowledge", inventory);
        graphResults.push(knowledgeQuality);
        writeJsonFile(knowledgeGraphPath, knowledgeQuality.graph);
        artifacts.add(KNOWLEDGE_GRAPH_FILE);
        artifacts.add(META_FILE);
        const domainIrPath = graphFilePath(options.graphRoot, DOMAIN_IR_FILE);
        if (existsSync(domainIrPath) || options.jobKind === "understand-domain") {
            if (!existsSync(domainIrPath)) {
                throw new Error(`Missing required artifact: ${DOMAIN_IR_FILE}`);
            }
            const normalized = normalizeDomainAnalysisIR(readJsonFile(domainIrPath));
            if (!normalized.ir) {
                const fatal = normalized.issues.map((item) => item.message).join("; ") || "Invalid DomainAnalysisIR.";
                throw new Error(fatal);
            }
            const compiled = compileDomainGraph(normalized.ir, knowledgeQuality.graph, inventory, meta);
            const domainQuality = repairAndAssessGraphQuality(compiled.graph, "domain", inventory);
            const extraIssues = [...normalized.issues, ...compiled.issues];
            if (shouldValidateChinese(options.locale, options.strictVisibleLanguage)) {
                validateChineseVisibleContent(DOMAIN_GRAPH_FILE, domainQuality.graph);
            }
            writeJsonFile(graphFilePath(options.graphRoot, DOMAIN_GRAPH_FILE), domainQuality.graph);
            artifacts.add(DOMAIN_IR_FILE);
            artifacts.add(DOMAIN_GRAPH_FILE);
            warnings.push(...extraIssues.filter((item) => item.level === "warning").map((item) => item.message));
            graphResults.push({
                ...domainQuality,
                issues: [...domainQuality.issues, ...extraIssues],
            });
        }
        const gitCommitHash = options.expectedGitCommitHash ?? String(meta.gitCommitHash || knowledgeGraph.project.gitCommitHash || "");
        const fingerprints = buildFingerprints(options.projectRoot, inventory, graphResults, gitCommitHash);
        writeJsonFile(graphFilePath(options.graphRoot, FINGERPRINTS_FILE), fingerprints);
        artifacts.add(FINGERPRINTS_FILE);
        const fingerprintFiles = Object.keys(fingerprints.files).sort();
        const fingerprintCandidates = collectFingerprintCandidatePaths(inventory, graphResults.map((item) => item.graph), MAX_FINGERPRINT_FILE_BYTES);
        const report = buildQualityReport({
            projectId: options.jobId,
            inventory,
            graphResults,
            fingerprintFiles,
            fingerprintCandidates,
        });
        writeJsonFile(graphFilePath(options.graphRoot, QUALITY_REPORT_FILE), report);
        artifacts.add(QUALITY_REPORT_FILE);
        if (hasFatalQuality(report)) {
            throw new Error(`Quality report contains blocking issues: fatal=${report.issueCounts.fatal}, error=${report.issueCounts.error}`);
        }
        observation(observations, {
            kind: "quality",
            level: "success",
            title: "分析产物校验通过",
            message: `质量报告通过，fingerprints 覆盖 ${fingerprintFiles.length}/${fingerprintCandidates.length} 个候选文件。`,
            stage: "validate",
            status: "succeeded",
            details: {
                issueCounts: report.issueCounts,
                fingerprintFiles: fingerprintFiles.length,
                fingerprintCandidates: fingerprintCandidates.length,
            },
        });
        return {
            ok: true,
            artifacts: [...artifacts].sort(),
            observations,
            quality: report,
            warnings,
        };
    }
    catch (error) {
        const fatal = error instanceof Error ? error.message : String(error);
        observation(observations, {
            kind: "error",
            level: "error",
            title: "分析产物校验失败",
            message: fatal,
            stage: "validate",
            status: "failed",
        });
        return {
            ok: false,
            artifacts: [...artifacts].sort(),
            observations,
            fatal,
            warnings,
        };
    }
}
//# sourceMappingURL=output-pipeline.js.map