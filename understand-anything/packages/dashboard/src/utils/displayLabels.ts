const NODE_TYPE_LABELS: Record<string, string> = {
  file: "文件",
  function: "函数",
  class: "类",
  module: "模块",
  concept: "概念",
  config: "配置",
  document: "文档",
  service: "服务",
  table: "数据表",
  endpoint: "接口",
  pipeline: "流水线",
  schema: "模式",
  resource: "资源",
  domain: "领域",
  flow: "流程",
  step: "步骤",
  article: "文章",
  entity: "实体",
  topic: "主题",
  claim: "论点",
  source: "来源",
};

const COMPLEXITY_LABELS: Record<string, string> = {
  simple: "简单",
  moderate: "中等",
  complex: "复杂",
};

const EDGE_CATEGORY_LABELS: Record<string, string> = {
  structural: "结构",
  behavioral: "行为",
  "data-flow": "数据流",
  dependencies: "依赖",
  semantic: "语义",
  infrastructure: "基础设施",
  domain: "领域",
  knowledge: "知识",
};

export function nodeTypeLabel(type: string | undefined): string {
  if (!type) return "未知";
  return NODE_TYPE_LABELS[type] ?? `类型：${type}`;
}

export function complexityLabel(complexity: string | undefined): string {
  if (!complexity) return "未知";
  return COMPLEXITY_LABELS[complexity] ?? `复杂度：${complexity}`;
}

export function edgeCategoryLabel(category: string): string {
  return EDGE_CATEGORY_LABELS[category] ?? `类别：${category}`;
}
