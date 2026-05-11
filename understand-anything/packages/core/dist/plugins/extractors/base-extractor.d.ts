import type { TreeSitterNode } from "./types.js";
/** Recursively traverse an AST tree, calling the visitor for each node. */
export declare function traverse(node: TreeSitterNode, visitor: (node: TreeSitterNode) => void): void;
/** Extract the unquoted string value from a string-like node. */
export declare function getStringValue(node: TreeSitterNode): string;
/** Find the first child matching a type. */
export declare function findChild(node: TreeSitterNode, type: string): TreeSitterNode | null;
/** Find all children matching a type. */
export declare function findChildren(node: TreeSitterNode, type: string): TreeSitterNode[];
/** Check if a node has a child of the given type (used for export/visibility checks). */
export declare function hasChildOfType(node: TreeSitterNode, type: string): boolean;
//# sourceMappingURL=base-extractor.d.ts.map