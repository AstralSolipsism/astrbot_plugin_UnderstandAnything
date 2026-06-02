import type { GraphSceneLevel, GraphSceneNode } from "./graphSceneTypes";

export type GraphSceneNodeAction =
  | { type: "drill-layer"; layerId: string }
  | { type: "select-node"; nodeId: string }
  | { type: "toggle-container"; containerId: string };

function stringData(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getGraphSceneNodeAction(
  level: GraphSceneLevel,
  node: GraphSceneNode,
): GraphSceneNodeAction {
  if (level === "overview") {
    return {
      type: "drill-layer",
      layerId: stringData(node.data, "layerId") ?? node.id,
    };
  }

  if (node.kind === "portal") {
    return {
      type: "drill-layer",
      layerId: stringData(node.data, "targetLayerId") ?? node.id.replace(/^portal:/, ""),
    };
  }

  if (node.kind === "container") {
    return {
      type: "toggle-container",
      containerId: stringData(node.data, "containerId") ?? node.id,
    };
  }

  return {
    type: "select-node",
    nodeId: node.id,
  };
}
