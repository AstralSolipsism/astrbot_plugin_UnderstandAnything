/** Recursively traverse an AST tree, calling the visitor for each node. */
export function traverse(node, visitor) {
    visitor(node);
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child)
            traverse(child, visitor);
    }
}
/** Extract the unquoted string value from a string-like node. */
export function getStringValue(node) {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === "string_fragment") {
            return child.text;
        }
    }
    return node.text.replace(/^['"`]|['"`]$/g, "");
}
/** Find the first child matching a type. */
export function findChild(node, type) {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === type)
            return child;
    }
    return null;
}
/** Find all children matching a type. */
export function findChildren(node, type) {
    const result = [];
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === type)
            result.push(child);
    }
    return result;
}
/** Check if a node has a child of the given type (used for export/visibility checks). */
export function hasChildOfType(node, type) {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === type)
            return true;
    }
    return false;
}
//# sourceMappingURL=base-extractor.js.map