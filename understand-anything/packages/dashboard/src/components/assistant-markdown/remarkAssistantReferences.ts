import {
  findAssistantReferenceMatches,
  type AssistantReferenceIndex,
} from "./assistantReferenceIndex";

interface MarkdownParentNode {
  type: string;
  children?: MarkdownNode[];
}

interface MarkdownTextNode {
  type: "text";
  value: string;
}

type MarkdownNode = MarkdownParentNode | MarkdownTextNode | { type: string; [key: string]: unknown };

interface RemarkAssistantReferencesOptions {
  referenceIndex?: AssistantReferenceIndex | null;
}

const SKIP_CHILDREN_TYPES = new Set([
  "code",
  "definition",
  "html",
  "inlineCode",
  "link",
  "linkReference",
  "toml",
  "yaml",
]);

function isTextNode(node: MarkdownNode): node is MarkdownTextNode {
  return node.type === "text" && typeof (node as MarkdownTextNode).value === "string";
}

function isParentNode(node: MarkdownNode): node is MarkdownParentNode {
  return Array.isArray((node as MarkdownParentNode).children);
}

function splitTextNode(node: MarkdownTextNode, referenceIndex: AssistantReferenceIndex): MarkdownNode[] {
  const matches = findAssistantReferenceMatches(node.value, referenceIndex);
  if (matches.length === 0) return [node];

  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      nodes.push({ type: "text", value: node.value.slice(cursor, match.start) });
    }
    nodes.push({
      type: "link",
      url: match.href,
      title: null,
      children: [{ type: "text", value: match.text }],
    });
    cursor = match.end;
  }
  if (cursor < node.value.length) {
    nodes.push({ type: "text", value: node.value.slice(cursor) });
  }
  return nodes;
}

function transformNode(node: MarkdownNode, referenceIndex: AssistantReferenceIndex): void {
  if (!isParentNode(node) || SKIP_CHILDREN_TYPES.has(node.type)) return;

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children ?? []) {
    if (isTextNode(child)) {
      nextChildren.push(...splitTextNode(child, referenceIndex));
      continue;
    }
    transformNode(child, referenceIndex);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkAssistantReferences(options: RemarkAssistantReferencesOptions = {}) {
  const referenceIndex = options.referenceIndex ?? null;
  return (tree: MarkdownNode) => {
    if (!referenceIndex || referenceIndex.entries.length === 0) return;
    transformNode(tree, referenceIndex);
  };
}
