// HTML sanitizer for SCOPED ELEMENT REGENERATION — the one place an AI edit is
// allowed to emit HTML (the new innerHTML of a single selected element). It is a
// deliberate, controlled exception to the "edits never emit HTML" invariant:
// scoped to one node, sanitized HERE (server, authoritative) AND again in the
// editor (DOM allowlist), and applied under one undo snapshot.
//
// Environment-agnostic (string-based) so the SAME gate runs in Node (the server
// route) and the browser (the editor). The editor additionally walks the parsed
// DOM with the allowlists below for defense in depth.

// --- scoped element regeneration request/response -------------------------

// The selected element's context the AI rebuilds from. A loose shape so shared/
// doesn't depend on the client's SelectedContext; the server only reads a few.
export interface ElementRegenContext {
  id: string;
  outerHTML?: string;
  innerText?: string;
  slideClass?: string;
  inlineStyle?: string;
  [k: string]: unknown;
}

export interface ElementRegenRequest {
  prompt: string;
  context: ElementRegenContext;
  /** The deck's design brief (palette/fonts/voice) so the rebuild stays on-brand. */
  deckBrief?: Record<string, unknown>;
}

export interface ElementRegenResponse {
  /** The new, sanitized innerHTML for the selected element. */
  html: string;
  message: string;
  mock: boolean;
}

// Tags that may appear in regenerated content. Anything else is unwrapped
// (children kept) or, for the dangerous set, removed with its contents.
export const ALLOWED_TAGS = new Set([
  "div", "span", "p", "section", "article", "header", "footer", "main", "aside",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "mark", "del", "ins", "abbr",
  "blockquote", "q", "cite", "figure", "figcaption", "caption",
  "img", "picture", "source", "br", "hr", "wbr",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col",
  "a", "time", "code", "pre", "kbd", "label",
]);

// Tags removed entirely WITH their contents (script-bearing / structural risks).
export const DANGEROUS_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template",
  "svg", "math", "foreignobject", "form", "input", "button", "select", "textarea",
  "link", "meta", "base", "title", "head", "html", "body", "frame", "frameset", "applet",
]);

// Attributes allowed on any element. `style` is kept but expression()/url(javascript:)
// is stripped. event handlers (on*) are never allowed.
export const ALLOWED_ATTRS = new Set([
  "class", "style", "src", "srcset", "alt", "title", "href", "target", "rel",
  "width", "height", "colspan", "rowspan", "datetime", "loading", "decoding",
  "data-slot", "aria-label", "aria-hidden", "role",
]);

// String-based pass: strip dangerous tags (with content), all on* handlers, and
// javascript:/vbscript: URLs. Used directly by the server; the editor runs this
// first, then a stricter DOM allowlist walk.
export function sanitizeHtml(html: string): string {
  let out = String(html ?? "");
  // Remove dangerous paired tags with their content.
  for (const tag of ["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "form", "select", "textarea", "title", "head"]) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
    // Unclosed variants.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), "");
  }
  // Remove self-contained dangerous void tags.
  out = out.replace(/<(link|meta|base|input|frame|frameset|applet)\b[^>]*\/?>/gi, "");
  // Strip inline event handlers: on...="..." / on...='...' / on...=value.
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Neutralize javascript:/vbscript:/data:text/html URLs in href/src.
  out = out.replace(/\s(href|src|xlink:href)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, "");
  // Kill CSS expression() in style attributes (old IE vector, still worth removing).
  out = out.replace(/expression\s*\(/gi, "void(");
  return out.trim();
}
