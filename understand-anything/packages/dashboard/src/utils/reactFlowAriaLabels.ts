import type { AriaLabelConfig } from "@xyflow/react";

export const zhReactFlowAriaLabels: Partial<AriaLabelConfig> = {
  "node.a11yDescription.default": "按回车或空格选择节点，按 Delete 删除节点，按 Escape 取消选择。",
  "node.a11yDescription.keyboardDisabled":
    "按回车或空格选择节点，然后可以使用方向键移动节点，按 Delete 删除节点，按 Escape 取消选择。",
  "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }) =>
    `节点已向${direction}移动到 ${x}、${y}。`,
  "edge.a11yDescription.default": "按回车或空格选择关系，按 Delete 删除关系，按 Escape 取消选择。",
  "controls.ariaLabel": "图谱控制",
  "controls.zoomIn.ariaLabel": "放大",
  "controls.zoomOut.ariaLabel": "缩小",
  "controls.fitView.ariaLabel": "适应视图",
  "controls.interactive.ariaLabel": "切换交互",
  "minimap.ariaLabel": "缩略图",
  "handle.ariaLabel": "连接点",
};
