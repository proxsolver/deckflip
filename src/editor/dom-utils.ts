// Pure, dependency-free DOM/CSS helpers used across the editor. Nothing here
// touches editor STATE or the overlay — they take arguments and return values, so
// every other editor module can import them without creating a cycle.

export function computedNumber(value: unknown, fallback = 0): number {
  const n = Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}

export function px(value: unknown): string {
  return `${Math.round(Number(value) || 0)}px`;
}

export function cssLength(value: unknown, defaultUnit = "px"): string {
  if (value == null) return "";
  if (typeof value === "number") return `${value}${defaultUnit}`;
  const text = String(value).trim();
  if (!text) return "";
  if (/^-?\d+(\.\d+)?$/.test(text)) return `${text}${defaultUnit}`;
  return text;
}

export function cssPxNumber(value: unknown, fallback = 0): number {
  if (value === "auto" || value === "" || value == null) return fallback;
  return computedNumber(value, fallback);
}

export function isMediaElement(el: Element | null): boolean {
  return !!(el && ["IMG", "CANVAS", "SVG", "VIDEO", "IFRAME"].includes(el.tagName));
}

export function colorLooksVisible(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  return !!v && v !== "transparent" && v !== "rgba(0, 0, 0, 0)" && v !== "rgba(0,0,0,0)";
}

export function borderLooksVisible(cs: CSSStyleDeclaration): boolean {
  const widths = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(
    (v) => Number.parseFloat(v) || 0
  );
  const styles = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  return widths.some((w) => w > 0) && ["solid", "dashed", "dotted", "double"].some((s) => styles.includes(s));
}

export function normalizedTextNodeValue(node: Node): string {
  return (node.textContent || "").replace(/\s+/g, " ").trim();
}

// True when the node is part of the editor's own overlay UI (so handlers ignore it).
export function isEditorUi(el: EventTarget | null): boolean {
  const node = el as Element | null;
  return !!(node && node.closest && node.closest('[data-html-ppt-editor="true"]'));
}
