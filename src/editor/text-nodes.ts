// Text-node discipline — the load-bearing rule that text editing rewrites TEXT
// NODES via TreeWalker, never innerHTML, so nested <strong>/<span>/<cite> survive
// and newline-separated lines map onto existing nodes. Pure (DOM + args only);
// imports nothing from core, so core can import it freely.

import { isMediaElement, normalizedTextNodeValue } from "./dom-utils";

function isForbiddenTextNodeParent(el: Element | null): boolean {
  return !!(el && el.closest && el.closest('script, style, noscript, template, [data-html-ppt-editor="true"]'));
}

// Meaningful text nodes of an element (skipping script/style/forbidden parents).
// `includeEmpty` keeps now-empty/whitespace-only nodes too — used only as a
// fallback when WRITING text into an element the user just cleared, so an
// emptied box stays editable (its text node still exists, just blank). The
// selection/text-safety heuristics keep the default (non-empty) behavior.
export function textNodesFor(el: Element | null, includeEmpty = false): Text[] {
  if (!el || isMediaElement(el)) return [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (!parent || isForbiddenTextNodeParent(parent)) return NodeFilter.FILTER_REJECT;
      const value = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (value) return NodeFilter.FILTER_ACCEPT;
      if (!includeEmpty) return NodeFilter.FILTER_REJECT;
      // Fallback (writing into a just-cleared element): accept an empty node ONLY
      // if it's a real content slot, never inter-element indentation whitespace.
      // Structural whitespace sits beside an element sibling (e.g. the newlines
      // around a title's inner <span>); an emptied content node is the lone text
      // of a leaf. This keeps re-typed text in the originally-styled node so a
      // cleared title comes back at its real size, not the container default.
      const siblings = node.parentNode ? node.parentNode.childNodes : null;
      if (siblings) {
        for (let i = 0; i < siblings.length; i++) {
          if (siblings[i].nodeType === 1) return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

export function isTextSafe(el: Element | null): boolean {
  if (!el || isMediaElement(el)) return false;
  return textNodesFor(el).length > 0;
}

export function isEditableTextElement(el: Element | null): boolean {
  return isTextSafe(el);
}

export function getEditableText(el: Element | null): string {
  if (!el) return "";
  return textNodesFor(el).map(normalizedTextNodeValue).filter(Boolean).join("\n");
}

function setTextNodePreservingOuterWhitespace(node: Node, value: string): void {
  const original = node.textContent || "";
  const leading = (original.match(/^\s*/) || [""])[0];
  const trailing = (original.match(/\s*$/) || [""])[0];
  node.textContent = leading + String(value ?? "") + trailing;
}

export function setEditableText(el: Element | null, value: string): boolean {
  if (!el || isMediaElement(el)) return false;
  // Prefer the meaningful text nodes (preserves nested tags + line mapping).
  // If the element was just emptied it has none, so fall back to its now-blank
  // text nodes so the user can type text back in instead of being stuck.
  let nodes = textNodesFor(el);
  if (!nodes.length) nodes = textNodesFor(el, true);
  if (!nodes.length) return false;
  const lines = String(value).replace(/\r\n/g, "\n").split("\n");
  nodes.forEach((node, index) => {
    setTextNodePreservingOuterWhitespace(node, index < lines.length ? lines[index] : "");
  });
  if (lines.length > nodes.length) {
    const extra = lines.slice(nodes.length).join(" ");
    if (extra.trim()) {
      const last = nodes[nodes.length - 1];
      setTextNodePreservingOuterWhitespace(last, normalizedTextNodeValue(last) + " " + extra.trim());
    }
  }
  return true;
}
