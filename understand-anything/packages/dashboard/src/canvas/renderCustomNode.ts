import type { GraphSceneNode } from "../graph-scene/graphSceneTypes";
import { complexityLabel, nodeTypeLabel } from "../utils/displayLabels";
import type { RectPaintSpec, TextPaintSpec } from "./renderLayerCluster";

export interface CustomNodePaintSpec {
  card: RectPaintSpec;
  strip: RectPaintSpec;
  testedMarker?: RectPaintSpec;
  texts: TextPaintSpec[];
}

const typeColors: Record<string, string> = {
  file: "var(--color-node-file)",
  function: "var(--color-node-function)",
  class: "var(--color-node-class)",
  module: "var(--color-node-module)",
  concept: "var(--color-node-concept)",
  config: "var(--color-node-config)",
  document: "var(--color-node-document)",
  service: "var(--color-node-service)",
  table: "var(--color-node-table)",
  endpoint: "var(--color-node-endpoint)",
  pipeline: "var(--color-node-pipeline)",
  schema: "var(--color-node-schema)",
  resource: "var(--color-node-resource)",
  domain: "var(--color-node-concept)",
  flow: "var(--color-node-pipeline)",
  step: "var(--color-node-function)",
  article: "var(--color-node-article)",
  entity: "var(--color-node-entity)",
  topic: "var(--color-node-topic)",
  claim: "var(--color-node-claim)",
  source: "var(--color-node-source)",
};

const complexityColors: Record<string, string> = {
  simple: "var(--color-node-function)",
  moderate: "var(--color-accent-dim)",
  complex: "#c97070",
};

function stringData(data: Record<string, unknown>, key: string, fallback: string): string {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function hasTestedTag(data: Record<string, unknown>): boolean {
  const tags = data.tags;
  return Array.isArray(tags) && tags.includes("tested");
}

export function buildCustomNodePaintSpec(node: GraphSceneNode): CustomNodePaintSpec {
  const nodeType = stringData(node.data, "nodeType", "file");
  const complexity = stringData(node.data, "complexity", "simple");

  return {
    card: {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      fill: "var(--color-elevated)",
      stroke: node.state.selected ? "var(--color-accent)" : "var(--color-border-subtle)",
      strokeWidth: node.state.selected ? 2 : 1,
      cornerRadius: 8,
    },
    strip: {
      x: node.x,
      y: node.y,
      width: 4,
      height: node.height,
      fill: typeColors[nodeType] ?? typeColors.file,
      cornerRadius: 8,
    },
    testedMarker: hasTestedTag(node.data)
      ? {
          x: node.x + node.width - 24,
          y: node.y + 20,
          width: 6,
          height: 6,
          fill: "var(--color-node-function)",
          cornerRadius: 3,
        }
      : undefined,
    texts: [
      {
        x: node.x + 16,
        y: node.y + 14,
        text: nodeTypeLabel(nodeType),
        fill: typeColors[nodeType] ?? typeColors.file,
        fontSize: 10,
        fontWeight: 600,
      },
      {
        x: node.x + node.width - 64,
        y: node.y + 14,
        text: complexityLabel(complexity),
        fill: complexityColors[complexity] ?? complexityColors.simple,
        fontSize: 9,
        fontWeight: 600,
      },
      {
        x: node.x + 16,
        y: node.y + 42,
        text: stringData(node.data, "label", "未命名"),
        fill: "var(--color-text-primary)",
        fontSize: 14,
        fontWeight: 400,
        width: node.width - 32,
      },
      {
        x: node.x + 16,
        y: node.y + 68,
        text: stringData(node.data, "summary", ""),
        fill: "var(--color-text-secondary)",
        fontSize: 11,
        width: node.width - 32,
      },
    ],
  };
}
