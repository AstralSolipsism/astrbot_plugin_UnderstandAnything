import { describe, expect, it } from "vitest";
import { validateGraph } from "@understand-anything/core";
import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import {
  compileDomainGraph,
  normalizeDomainAnalysisIR,
  type DomainAnalysisIR,
} from "../domain-analysis-ir.js";
import type { SourceInventory, SourceInventoryCategory, SourceInventoryEntry } from "../quality.js";

function node(overrides: Partial<GraphNode> & Pick<GraphNode, "id" | "type" | "name">): GraphNode {
  return {
    summary: `${overrides.name} 摘要`,
    tags: ["测试"],
    complexity: "moderate",
    ...overrides,
  };
}

function knowledgeGraph(): KnowledgeGraph {
  const nodes = [
    node({ id: "file:src/orders.ts", type: "file", name: "orders.ts", filePath: "src/orders.ts", lineRange: [1, 80] }),
    node({ id: "function:create-order", type: "function", name: "createOrder", filePath: "src/orders.ts", lineRange: [10, 40] }),
    node({ id: "file:src/payments.ts", type: "file", name: "payments.ts", filePath: "src/payments.ts", lineRange: [1, 60] }),
  ];
  return {
    version: "1.0.0",
    project: {
      name: "订单系统",
      languages: ["typescript"],
      frameworks: ["express"],
      description: "用于测试领域图编译的中文项目。",
      analyzedAt: new Date(0).toISOString(),
      gitCommitHash: "knowledge-hash",
    },
    nodes,
    edges: [
      { source: "file:src/orders.ts", target: "function:create-order", type: "contains", direction: "forward", weight: 1 },
    ],
    layers: [{ id: "layer:code", name: "代码层", description: "代码层", nodeIds: nodes.map((item) => item.id) }],
    tour: [],
  };
}

function entry(
  path: string,
  kind: SourceInventoryEntry["kind"],
  category: SourceInventoryCategory = "code",
): SourceInventoryEntry {
  return {
    path,
    kind,
    language: kind === "directory" ? "directory" : "typescript",
    sizeBytes: kind === "directory" ? 0 : 120,
    lineCount: kind === "directory" ? 0 : 100,
    hash: `hash:${path}`,
    category,
  };
}

function inventory(): SourceInventory {
  const entries = [
    entry("src", "directory"),
    entry("src/orders.ts", "file"),
    entry("src/payments.ts", "file"),
  ];
  return {
    version: "1.0.0",
    generatedAt: new Date(0).toISOString(),
    gitCommitHash: "inventory-hash",
    entries,
    totals: {
      files: entries.filter((item) => item.kind === "file").length,
      directories: entries.filter((item) => item.kind === "directory").length,
      bytes: entries.reduce((sum, item) => sum + item.sizeBytes, 0),
    },
  };
}

function validIr(): DomainAnalysisIR {
  return {
    version: "1.0.0",
    domains: [
      {
        id: "orders",
        name: "订单管理",
        summary: "负责创建订单、校验订单输入并协调支付流程。",
        tags: ["订单"],
        sourceNodeIds: ["file:src/orders.ts"],
        sourceFilePaths: ["src/orders.ts"],
        flows: [
          {
            id: "create",
            name: "创建订单",
            summary: "接收订单请求后创建业务订单并准备支付。",
            tags: ["创建"],
            entryPoint: "POST /orders",
            entryType: "http",
            sourceNodeIds: ["function:create-order"],
            sourceFilePaths: ["src/orders.ts"],
            steps: [
              {
                id: "validate",
                name: "校验输入",
                summary: "校验订单请求中的商品和用户信息。",
                tags: ["校验"],
                sourceNodeIds: ["function:create-order"],
                sourceFilePaths: ["src/orders.ts"],
                filePath: "src/orders.ts",
                lineRange: [10, 20],
              },
            ],
          },
        ],
      },
      {
        id: "payments",
        name: "支付处理",
        summary: "负责根据订单数据完成支付侧处理。",
        tags: ["支付"],
        sourceFilePaths: ["src/payments.ts"],
        flows: [],
      },
    ],
    crossDomainInteractions: [
      {
        fromDomainIdOrName: "orders",
        toDomainIdOrName: "payments",
        summary: "订单管理会把支付准备数据交给支付处理。",
        sourceFilePaths: ["src/orders.ts", "src/payments.ts"],
      },
    ],
  };
}

describe("DomainAnalysisIR runtime compiler", () => {
  it("rejects invalid IR shape before graph compilation", () => {
    const normalized = normalizeDomainAnalysisIR({
      version: "1.0.0",
      domains: [
        {
          name: "缺少摘要的领域",
        },
      ],
    });

    expect(normalized.ir?.domains).toEqual([]);
    expect(normalized.issues).toContainEqual(expect.objectContaining({
      level: "error",
      code: "domain-ir-invalid-domain",
    }));
  });

  it("warns about final graph fields and keeps backend project metadata authoritative", () => {
    const normalized = normalizeDomainAnalysisIR({
      version: "1.0.0",
      project: { name: "模型伪造项目" },
      nodes: [],
      edges: [],
      domains: [
        {
          name: "订单管理",
          summary: "负责处理订单生命周期。",
          type: "domain",
          domainMeta: {
            sourceFilePaths: ["src/orders.ts"],
            evidence: ["旧字段中的来源仍可兼容读取。"],
          },
        },
      ],
    });

    expect(normalized.ir).not.toBeNull();
    expect(normalized.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      "domain-ir-final-graph-field-ignored",
    ]));

    const compiled = compileDomainGraph(normalized.ir!, knowledgeGraph(), inventory(), { gitCommitHash: "meta-hash" });
    expect(compiled.graph.project.name).toBe("订单系统");
    expect(compiled.graph.project.gitCommitHash).toBe("meta-hash");
  });

  it("compiles legal IR into a deterministic valid domain graph", () => {
    const first = compileDomainGraph(validIr(), knowledgeGraph(), inventory(), { gitCommitHash: "meta-hash" });
    const second = compileDomainGraph(validIr(), knowledgeGraph(), inventory(), { gitCommitHash: "meta-hash" });

    expect(first.graph).toEqual(second.graph);
    expect(validateGraph(first.graph).success).toBe(true);
    expect(first.graph.nodes.map((item) => item.type)).toEqual(["domain", "flow", "step", "domain"]);
    expect(first.graph.edges.map((item) => item.type)).toEqual([
      "contains_flow",
      "flow_step",
      "cross_domain",
    ]);
    expect(first.issues.some((item) => item.level === "fatal" || item.level === "error")).toBe(false);
  });

  it("reports missing provenance as a blocking IR error", () => {
    const compiled = compileDomainGraph(
      {
        version: "1.0.0",
        domains: [
          {
            name: "无来源领域",
            summary: "这个领域没有任何来源证据。",
            flows: [],
          },
        ],
      },
      knowledgeGraph(),
      inventory(),
      {},
    );

    expect(compiled.issues).toContainEqual(expect.objectContaining({
      level: "error",
      code: "domain-ir-missing-provenance",
    }));
  });
});
