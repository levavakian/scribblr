// Bookkeeping that lets the rest of the content script tell our DOM changes apart from the page's.
//
// We never move or remove nodes the page owns: a translated chunk is shown by shortening the page's
// own text nodes and inserting our elements next to them. Frameworks like React keep references to
// their text nodes, so leaving those nodes in place means the page can keep updating them (e.g. a
// streaming chat reply) without crashing. When it does, we notice and undo our changes.

export const OWN_TAG = 'scribblr-t';
export const TOOLTIP_TAG = 'scribblr-tip';

export const TEXT_NODE = 3;
export const ELEMENT_NODE = 1;

/** Text nodes we inserted (untranslated text between two translated chunks of one page text node). */
export const ownTextNodes = new WeakSet<Node>();

/** Page text nodes we shortened, mapped to their original text. */
export const originalText = new WeakMap<Text, string>();

export function isOwnElement(el: Element): boolean {
  return el.localName === OWN_TAG || el.localName === TOOLTIP_TAG;
}

/** True for nodes we created, including the text inside our elements. */
export function isOwnNode(node: Node): boolean {
  if (ownTextNodes.has(node)) return true;
  if (node.nodeType === ELEMENT_NODE) return isOwnElement(node as Element);
  const parent = node.parentElement;
  return !!parent && isOwnElement(parent);
}
