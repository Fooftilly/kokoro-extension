// Helper function to find a DOM Range for given character indices within a root element's textContent
export function findRange(root, start, end) {
    let charCount = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;

    function walk(node) {
        if (startNode && endNode) return; // Stop early if both found

        if (node.nodeType === 3) { // Text node
            const len = node.length;
            const absoluteStart = charCount;
            const absoluteEnd = charCount + len;

            // Check if 'start' falls within this text node
            if (!startNode && start >= absoluteStart && start < absoluteEnd) {
                startNode = node;
                startOffset = start - absoluteStart;
            }
            // Check if 'end' falls within this text node
            // 'end' can be exactly 'absoluteEnd' (e.g., end of the node)
            if (!endNode && end > absoluteStart && end <= absoluteEnd) {
                endNode = node;
                endOffset = end - absoluteStart;
            }

            charCount += len;
        } else {
            // Traverse children for non-text nodes
            for (const child of node.childNodes) {
                walk(child);
                if (startNode && endNode) return; // Stop early if both found during child traversal
            }
        }
    }

    walk(root);

    if (startNode && endNode) {
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        return range;
    }
    // Return null if the range could not be fully determined (e.g., indices out of bounds)
    return null;
}
