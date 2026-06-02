import { createHash } from "node:crypto";
import { normalizeInventoryPath, sourceInventoryEntryMap, } from "./quality.js";
const FINAL_GRAPH_FIELDS = new Set(["project", "nodes", "edges", "layers", "tour", "kind", "gitCommitHash"]);
const FINAL_NODE_FIELDS = new Set(["type", "edgeType", "direction", "weight", "domainMeta", "project", "layers", "tour", "edges", "nodes"]);
const PLACEHOLDER_PATTERNS = ["文件不存在", "不存在或已被重命名", "未在磁盘上找到", "文件未在磁盘上找到", "该文件在仓库中不存在", "not found", "renamed"];
const VALID_ENTRY_TYPES = new Set(["http", "cli", "event", "cron", "manual", "document"]);
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function asString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asStringArray(value) {
    if (typeof value === "string" && value.trim())
        return [value.trim()];
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}
function issue(issues, level, code, message, details = {}) {
    issues.push({ level, graph: "domain", code, message, ...details });
}
function hashToken(input) {
    return createHash("sha1").update(input).digest("hex").slice(0, 10);
}
function idToken(input, fallbackPrefix) {
    const source = input?.trim() || fallbackPrefix;
    const ascii = source
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
    const base = ascii || `${fallbackPrefix}-${hashToken(source)}`;
    return base.length <= 56 ? base : `${base.slice(0, 45).replace(/-+$/g, "")}-${hashToken(source)}`;
}
function uniqueToken(base, used) {
    let candidate = base;
    let index = 2;
    while (used.has(candidate)) {
        candidate = `${base}-${index}`;
        index += 1;
    }
    used.add(candidate);
    return candidate;
}
function normalizeTags(value, fallback) {
    const tags = asStringArray(value);
    return tags.length > 0 ? [...new Set(tags)] : [fallback];
}
function normalizedEvidence(value) {
    return [...new Set(asStringArray(value))];
}
function nestedDomainMeta(record) {
    return asRecord(record.domainMeta);
}
function stringFromRecordOrMeta(record, field) {
    return asString(record[field]) ?? asString(nestedDomainMeta(record)?.[field]);
}
function stringArrayFromRecordOrMeta(record, field) {
    const direct = asStringArray(record[field]);
    if (direct.length > 0)
        return direct;
    return asStringArray(nestedDomainMeta(record)?.[field]);
}
function evidenceFromRecordOrMeta(record) {
    const direct = normalizedEvidence(record.evidence);
    if (direct.length > 0)
        return direct;
    return normalizedEvidence(nestedDomainMeta(record)?.evidence);
}
function hasPlaceholderText(...values) {
    const text = values.flatMap((value) => asStringArray(value)).join("\n").toLowerCase();
    return PLACEHOLDER_PATTERNS.some((pattern) => text.includes(pattern.toLowerCase()));
}
function warnUnexpectedFinalFields(issues, record, path) {
    for (const field of Object.keys(record)) {
        if (!FINAL_GRAPH_FIELDS.has(field) && !FINAL_NODE_FIELDS.has(field))
            continue;
        issue(issues, "warning", "domain-ir-final-graph-field-ignored", `DomainAnalysisIR 中包含最终图谱字段，已忽略：${path}.${field}`, { path: `${path}.${field}` });
    }
}
function normalizeStep(raw, issues, path) {
    const record = asRecord(raw);
    if (!record) {
        issue(issues, "error", "domain-ir-invalid-step", `领域 IR 步骤不是对象：${path}`, { path });
        return null;
    }
    warnUnexpectedFinalFields(issues, record, path);
    const name = asString(record.name);
    const summary = asString(record.summary) ?? asString(record.description);
    if (!name || !summary) {
        issue(issues, "error", "domain-ir-invalid-step", `领域 IR 步骤缺少 name 或 summary：${path}`, { path });
        return null;
    }
    return {
        id: asString(record.id),
        name,
        summary,
        tags: normalizeTags(record.tags, "步骤"),
        sourceNodeIds: stringArrayFromRecordOrMeta(record, "sourceNodeIds"),
        sourceFilePaths: stringArrayFromRecordOrMeta(record, "sourceFilePaths"),
        evidence: evidenceFromRecordOrMeta(record),
        filePath: asString(record.filePath),
        lineRange: Array.isArray(record.lineRange) && record.lineRange.length === 2 && Number.isInteger(record.lineRange[0]) && Number.isInteger(record.lineRange[1])
            ? [record.lineRange[0], record.lineRange[1]]
            : undefined,
    };
}
function normalizeFlow(raw, issues, path) {
    const record = asRecord(raw);
    if (!record) {
        issue(issues, "error", "domain-ir-invalid-flow", `领域 IR 流程不是对象：${path}`, { path });
        return null;
    }
    warnUnexpectedFinalFields(issues, record, path);
    const name = asString(record.name);
    const summary = asString(record.summary) ?? asString(record.description);
    if (!name || !summary) {
        issue(issues, "error", "domain-ir-invalid-flow", `领域 IR 流程缺少 name 或 summary：${path}`, { path });
        return null;
    }
    const steps = Array.isArray(record.steps)
        ? record.steps.map((item, index) => normalizeStep(item, issues, `${path}.steps[${index}]`)).filter((item) => item !== null)
        : [];
    const entryType = stringFromRecordOrMeta(record, "entryType");
    return {
        id: asString(record.id),
        name,
        summary,
        tags: normalizeTags(record.tags, "流程"),
        entryPoint: stringFromRecordOrMeta(record, "entryPoint"),
        entryType: entryType && VALID_ENTRY_TYPES.has(entryType) ? entryType : undefined,
        sourceNodeIds: stringArrayFromRecordOrMeta(record, "sourceNodeIds"),
        sourceFilePaths: stringArrayFromRecordOrMeta(record, "sourceFilePaths"),
        evidence: evidenceFromRecordOrMeta(record),
        steps,
    };
}
function normalizeDomain(raw, issues, path) {
    const record = asRecord(raw);
    if (!record) {
        issue(issues, "error", "domain-ir-invalid-domain", `领域 IR domain 不是对象：${path}`, { path });
        return null;
    }
    warnUnexpectedFinalFields(issues, record, path);
    const name = asString(record.name);
    const summary = asString(record.summary) ?? asString(record.description);
    if (!name || !summary) {
        issue(issues, "error", "domain-ir-invalid-domain", `领域 IR domain 缺少 name 或 summary：${path}`, { path });
        return null;
    }
    const flows = Array.isArray(record.flows)
        ? record.flows.map((item, index) => normalizeFlow(item, issues, `${path}.flows[${index}]`)).filter((item) => item !== null)
        : [];
    return {
        id: asString(record.id),
        name,
        summary,
        tags: normalizeTags(record.tags, "领域"),
        sourceNodeIds: stringArrayFromRecordOrMeta(record, "sourceNodeIds"),
        sourceFilePaths: stringArrayFromRecordOrMeta(record, "sourceFilePaths"),
        evidence: evidenceFromRecordOrMeta(record),
        flows,
    };
}
function normalizeCrossDomainInteraction(raw, issues, path) {
    const record = asRecord(raw);
    if (!record) {
        issue(issues, "error", "domain-ir-invalid-cross-domain", `领域 IR 跨领域关系不是对象：${path}`, { path });
        return null;
    }
    warnUnexpectedFinalFields(issues, record, path);
    const fromDomainIdOrName = asString(record.fromDomainIdOrName) ?? asString(record.from) ?? asString(record.source);
    const toDomainIdOrName = asString(record.toDomainIdOrName) ?? asString(record.to) ?? asString(record.target);
    const summary = asString(record.summary) ?? asString(record.description);
    if (!fromDomainIdOrName || !toDomainIdOrName || !summary) {
        issue(issues, "warning", "domain-ir-invalid-cross-domain-removed", `领域 IR 跨领域关系缺少端点或说明，已忽略：${path}`, { path });
        return null;
    }
    return {
        fromDomainIdOrName,
        toDomainIdOrName,
        summary,
        sourceNodeIds: stringArrayFromRecordOrMeta(record, "sourceNodeIds"),
        sourceFilePaths: stringArrayFromRecordOrMeta(record, "sourceFilePaths"),
        evidence: evidenceFromRecordOrMeta(record),
    };
}
export function normalizeDomainAnalysisIR(raw) {
    const issues = [];
    const record = asRecord(raw);
    if (!record) {
        issue(issues, "fatal", "domain-ir-invalid-root", "domain-analysis.json 格式不合法：根节点必须是对象");
        return { ir: null, issues };
    }
    warnUnexpectedFinalFields(issues, record, "root");
    if (!Array.isArray(record.domains)) {
        issue(issues, "fatal", "domain-ir-missing-domains", "domain-analysis.json 格式不合法：domains 必须是数组");
        return { ir: null, issues };
    }
    const domains = record.domains
        .map((item, index) => normalizeDomain(item, issues, `domains[${index}]`))
        .filter((item) => item !== null);
    if (domains.length === 0) {
        issue(issues, "fatal", "domain-ir-empty-domains", "domain-analysis.json 没有可用领域");
    }
    const crossDomainInteractions = Array.isArray(record.crossDomainInteractions)
        ? record.crossDomainInteractions
            .map((item, index) => normalizeCrossDomainInteraction(item, issues, `crossDomainInteractions[${index}]`))
            .filter((item) => item !== null)
        : [];
    return { ir: { version: asString(record.version) ?? "1.0.0", domains, crossDomainInteractions }, issues };
}
function cleanSourceNodeIds(rawIds, nodeIds, issues, nodeName, nodeId, kind) {
    const output = [];
    const seen = new Set();
    for (const rawId of rawIds ?? []) {
        if (!rawId || seen.has(rawId))
            continue;
        seen.add(rawId);
        if (!nodeIds.has(rawId)) {
            issue(issues, "warning", "domain-ir-source-node-missing-removed", `领域 ${kind} 来源节点不存在，已移除：${nodeName}`, { nodeId, path: rawId });
            continue;
        }
        output.push(rawId);
    }
    return output;
}
function cleanSourceFilePaths(rawPaths, inventory, issues, nodeName, nodeId, kind) {
    const inventoryMap = sourceInventoryEntryMap(inventory);
    const output = [];
    const seen = new Set();
    for (const rawPath of rawPaths ?? []) {
        const normalizedPath = normalizeInventoryPath(rawPath);
        const pathText = typeof rawPath === "string" ? rawPath : undefined;
        if (!normalizedPath) {
            issue(issues, "warning", "domain-ir-source-filepath-invalid-removed", `领域 ${kind} 来源路径不合法，已移除：${nodeName}`, { nodeId, path: pathText });
            continue;
        }
        if (seen.has(normalizedPath)) {
            issue(issues, "warning", "domain-ir-source-filepath-duplicate-removed", `领域 ${kind} 来源路径重复，已去重：${nodeName}`, { nodeId, path: normalizedPath });
            continue;
        }
        seen.add(normalizedPath);
        const entry = inventoryMap.get(normalizedPath);
        if (!entry) {
            issue(issues, "warning", "domain-ir-source-filepath-missing-removed", `领域 ${kind} 来源路径不存在，已移除：${nodeName}`, { nodeId, path: normalizedPath });
            continue;
        }
        if (entry.kind !== "file") {
            issue(issues, "warning", "domain-ir-source-filepath-directory-removed", `领域 ${kind} 来源路径指向目录，已移除：${nodeName}`, { nodeId, path: normalizedPath });
            continue;
        }
        output.push(normalizedPath);
    }
    return output;
}
function cleanStepFilePath(rawPath, inventory, issues, nodeName, nodeId) {
    if (!rawPath)
        return undefined;
    const normalizedPath = normalizeInventoryPath(rawPath);
    if (!normalizedPath) {
        issue(issues, "warning", "domain-ir-step-filepath-invalid-removed", `领域步骤 filePath 不合法，已移除：${nodeName}`, { nodeId, path: rawPath });
        return undefined;
    }
    const entry = sourceInventoryEntryMap(inventory).get(normalizedPath);
    if (!entry || entry.kind !== "file") {
        issue(issues, "warning", "domain-ir-step-filepath-missing-removed", `领域步骤 filePath 不存在或不是文件，已移除：${nodeName}`, { nodeId, path: normalizedPath });
        return undefined;
    }
    return normalizedPath;
}
function cleanLineRange(range, filePath, inventory, issues, nodeName, nodeId) {
    if (!range || !filePath)
        return undefined;
    const entry = sourceInventoryEntryMap(inventory).get(filePath);
    const [start, end] = range;
    if (start < 1 || end < start || (entry && entry.lineCount > 0 && end > entry.lineCount)) {
        issue(issues, "warning", "domain-ir-line-range-invalid-removed", `领域步骤行号范围无效，已移除：${nodeName}`, { nodeId, path: filePath });
        return undefined;
    }
    return range;
}
function cleanProvenance(owner, options) {
    const sourceNodeIds = cleanSourceNodeIds(owner.sourceNodeIds, options.nodeIds, options.issues, options.nodeName, options.nodeId, options.kind);
    const sourceFilePaths = cleanSourceFilePaths(owner.sourceFilePaths, options.inventory, options.issues, options.nodeName, options.nodeId, options.kind);
    const evidence = normalizedEvidence(owner.evidence);
    if (sourceNodeIds.length === 0 && sourceFilePaths.length === 0 && evidence.length === 0) {
        issue(options.issues, "error", "domain-ir-missing-provenance", `领域 ${options.kind} 缺少可验证来源证据：${options.nodeName}`, { nodeId: options.nodeId });
    }
    return {
        ...(sourceNodeIds.length > 0 ? { sourceNodeIds } : {}),
        ...(sourceFilePaths.length > 0 ? { sourceFilePaths } : {}),
        ...(evidence.length > 0 ? { evidence } : {}),
    };
}
function projectMetaFrom(knowledgeGraph, meta) {
    const gitCommitHash = typeof meta.gitCommitHash === "string" && meta.gitCommitHash.trim()
        ? meta.gitCommitHash.trim()
        : knowledgeGraph.project.gitCommitHash;
    return {
        name: knowledgeGraph.project.name,
        languages: knowledgeGraph.project.languages,
        frameworks: knowledgeGraph.project.frameworks,
        description: knowledgeGraph.project.description,
        analyzedAt: knowledgeGraph.project.analyzedAt,
        gitCommitHash,
    };
}
function addNode(nodes, node) {
    nodes.push(node);
}
function edgeWeight(index, total) {
    if (total <= 1)
        return 1;
    return Math.max(0.1, Math.min(1, Number(((index + 1) / total).toFixed(1))));
}
function findDomainId(reference, domainMap) {
    const stripped = reference.replace(/^domain:/, "");
    return domainMap.get(reference)
        ?? domainMap.get(reference.toLowerCase())
        ?? domainMap.get(stripped)
        ?? domainMap.get(stripped.toLowerCase())
        ?? domainMap.get(idToken(stripped, "domain"));
}
export function compileDomainGraph(ir, knowledgeGraph, inventory, meta) {
    const issues = [];
    const knowledgeNodeIds = new Set(knowledgeGraph.nodes.map((node) => node.id));
    const nodes = [];
    const edges = [];
    const usedDomainTokens = new Set();
    const domainMap = new Map();
    for (const domain of ir.domains) {
        if (hasPlaceholderText(domain.name, domain.summary, domain.evidence)) {
            issue(issues, "error", "domain-ir-placeholder-text", `领域 IR 包含占位文本：${domain.name}`);
        }
        const domainToken = uniqueToken(idToken(domain.id ?? domain.name, "domain"), usedDomainTokens);
        const domainId = `domain:${domainToken}`;
        domainMap.set(domain.name, domainId);
        domainMap.set(domain.name.toLowerCase(), domainId);
        if (domain.id)
            domainMap.set(domain.id, domainId);
        domainMap.set(domainToken, domainId);
        const provenance = cleanProvenance(domain, { nodeIds: knowledgeNodeIds, inventory, issues, nodeName: domain.name, nodeId: domainId, kind: "domain" });
        addNode(nodes, {
            id: domainId,
            type: "domain",
            name: domain.name,
            summary: domain.summary,
            tags: normalizeTags(domain.tags, "领域"),
            complexity: "moderate",
            domainMeta: provenance,
        });
        const usedFlowTokens = new Set();
        for (const flow of domain.flows ?? []) {
            if (hasPlaceholderText(flow.name, flow.summary, flow.evidence)) {
                issue(issues, "error", "domain-ir-placeholder-text", `领域 IR 流程包含占位文本：${flow.name}`, { nodeId: domainId });
            }
            const flowToken = uniqueToken(idToken(flow.id ?? flow.name, "flow"), usedFlowTokens);
            const flowId = `flow:${domainToken}:${flowToken}`;
            const flowProvenance = cleanProvenance(flow, { nodeIds: knowledgeNodeIds, inventory, issues, nodeName: flow.name, nodeId: flowId, kind: "flow" });
            addNode(nodes, {
                id: flowId,
                type: "flow",
                name: flow.name,
                summary: flow.summary,
                tags: normalizeTags(flow.tags, "流程"),
                complexity: "moderate",
                domainMeta: {
                    ...flowProvenance,
                    ...(flow.entryPoint ? { entryPoint: flow.entryPoint } : {}),
                    ...(flow.entryType ? { entryType: flow.entryType } : {}),
                },
            });
            edges.push({ source: domainId, target: flowId, type: "contains_flow", direction: "forward", weight: 1 });
            const usedStepTokens = new Set();
            const steps = flow.steps ?? [];
            for (let index = 0; index < steps.length; index += 1) {
                const step = steps[index];
                if (hasPlaceholderText(step.name, step.summary, step.evidence)) {
                    issue(issues, "error", "domain-ir-placeholder-text", `领域 IR 步骤包含占位文本：${step.name}`, { nodeId: flowId });
                }
                const stepToken = uniqueToken(idToken(step.id ?? step.name, "step"), usedStepTokens);
                const stepId = `step:${domainToken}:${flowToken}:${stepToken}`;
                const filePath = cleanStepFilePath(step.filePath, inventory, issues, step.name, stepId);
                const lineRange = cleanLineRange(step.lineRange, filePath, inventory, issues, step.name, stepId);
                const provenanceOwner = filePath
                    ? { ...step, sourceFilePaths: [...(step.sourceFilePaths ?? []), filePath] }
                    : step;
                const stepProvenance = cleanProvenance(provenanceOwner, { nodeIds: knowledgeNodeIds, inventory, issues, nodeName: step.name, nodeId: stepId, kind: "step" });
                addNode(nodes, {
                    id: stepId,
                    type: "step",
                    name: step.name,
                    summary: step.summary,
                    tags: normalizeTags(step.tags, "步骤"),
                    complexity: "moderate",
                    ...(filePath ? { filePath } : {}),
                    ...(lineRange ? { lineRange } : {}),
                    domainMeta: stepProvenance,
                });
                edges.push({ source: flowId, target: stepId, type: "flow_step", direction: "forward", weight: edgeWeight(index, steps.length) });
            }
        }
    }
    for (const interaction of ir.crossDomainInteractions ?? []) {
        if (hasPlaceholderText(interaction.summary, interaction.evidence)) {
            issue(issues, "error", "domain-ir-placeholder-text", `领域 IR 跨领域关系包含占位文本：${interaction.summary}`);
        }
        const source = findDomainId(interaction.fromDomainIdOrName, domainMap);
        const target = findDomainId(interaction.toDomainIdOrName, domainMap);
        if (!source || !target || source === target) {
            issue(issues, "warning", "domain-ir-cross-domain-unresolved", `跨领域关系端点无法解析，已忽略：${interaction.fromDomainIdOrName} -> ${interaction.toDomainIdOrName}`);
            continue;
        }
        cleanProvenance(interaction, { nodeIds: knowledgeNodeIds, inventory, issues, nodeName: interaction.summary, nodeId: `${source}->${target}`, kind: "cross-domain" });
        edges.push({ source, target, type: "cross_domain", direction: "forward", description: interaction.summary, weight: 0.6 });
    }
    return {
        graph: {
            version: "1.0.0",
            project: projectMetaFrom(knowledgeGraph, meta),
            nodes,
            edges,
            layers: [],
            tour: [],
        },
        issues,
    };
}
function nodeToIrBase(node) {
    return {
        id: node.id.replace(/^(domain|flow|step):/, ""),
        name: node.name,
        summary: node.summary,
        tags: node.tags,
        sourceNodeIds: node.domainMeta?.sourceNodeIds,
        sourceFilePaths: node.domainMeta?.sourceFilePaths,
        evidence: node.domainMeta?.evidence,
    };
}
export function domainGraphToIR(graph) {
    const domainNodes = graph.nodes.filter((node) => node.type === "domain");
    const flowNodes = graph.nodes.filter((node) => node.type === "flow");
    const stepNodes = graph.nodes.filter((node) => node.type === "step");
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const flowsByDomain = new Map();
    const stepsByFlow = new Map();
    const crossDomainInteractions = [];
    for (const edge of graph.edges) {
        const source = nodesById.get(edge.source);
        const target = nodesById.get(edge.target);
        if (!source || !target)
            continue;
        if (source.type === "domain" && target.type === "flow") {
            const flows = flowsByDomain.get(source.id) ?? [];
            flows.push(target);
            flowsByDomain.set(source.id, flows);
        }
        else if (source.type === "flow" && target.type === "step") {
            const steps = stepsByFlow.get(source.id) ?? [];
            steps.push(target);
            stepsByFlow.set(source.id, steps);
        }
        else if (source.type === "domain" && target.type === "domain") {
            crossDomainInteractions.push({
                fromDomainIdOrName: source.id,
                toDomainIdOrName: target.id,
                summary: edge.description ?? `${source.name} 影响 ${target.name}`,
                evidence: [edge.description ?? `${source.name} 与 ${target.name} 存在旧版领域图关系。`],
            });
        }
    }
    for (const flow of flowNodes) {
        if ([...flowsByDomain.values()].some((items) => items.includes(flow)))
            continue;
        const domain = domainNodes.find((item) => flow.id.includes(item.id.replace(/^domain:/, ""))) ?? domainNodes[0];
        if (!domain)
            continue;
        const flows = flowsByDomain.get(domain.id) ?? [];
        flows.push(flow);
        flowsByDomain.set(domain.id, flows);
    }
    for (const step of stepNodes) {
        if ([...stepsByFlow.values()].some((items) => items.includes(step)))
            continue;
        const flow = flowNodes.find((item) => {
            const parts = item.id.replace(/^flow:/, "").split(":");
            return step.id.includes(parts[parts.length - 1] ?? "");
        }) ?? flowNodes[0];
        if (!flow)
            continue;
        const steps = stepsByFlow.get(flow.id) ?? [];
        steps.push(step);
        stepsByFlow.set(flow.id, steps);
    }
    return {
        version: "1.0.0",
        domains: domainNodes.map((domain) => ({
            ...nodeToIrBase(domain),
            flows: (flowsByDomain.get(domain.id) ?? []).map((flow) => ({
                ...nodeToIrBase(flow),
                entryPoint: flow.domainMeta?.entryPoint,
                entryType: flow.domainMeta?.entryType,
                steps: (stepsByFlow.get(flow.id) ?? []).map((step) => ({
                    ...nodeToIrBase(step),
                    filePath: step.filePath,
                    lineRange: step.lineRange,
                })),
            })),
        })),
        crossDomainInteractions,
    };
}
//# sourceMappingURL=domain-analysis-ir.js.map