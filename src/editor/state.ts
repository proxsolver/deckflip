// Editor runtime state + the selector tables. Ported 1:1 from the STATE object
// and BLOCK_SELECTOR / NEVER_SELECT_SELECTOR in editor_bridge.js.

import type { EditorTool } from "@/types/messages";

export interface PointerDrag {
  target: HTMLElement;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  didDrag: boolean;
  // Per-element drag anchors so a multi-selection moves together by one delta.
  group: { el: HTMLElement; startX: number; startY: number }[];
}

export interface ResizeDrag {
  startClientX: number;
  startClientY: number;
  startW: number;
  startH: number;
}

export interface EditorState {
  enabled: boolean;
  tool: EditorTool;
  /** Full multi-selection, in click order. `selected` is its last element (the
   *  primary/anchor used for the resize handle, label, text-edit and drag). */
  selection: HTMLElement[];
  selected: HTMLElement | null;
  selectedId: string | null;
  idSeq: number;
  elementIds: WeakMap<Element, string>;
  idLookup: Map<string, Element>;
  pointer: PointerDrag | null;
  resize: ResizeDrag | null;
  currentSlideIndex: number;
  suppressNextClick: boolean;
  slideCheckTimer: ReturnType<typeof setTimeout> | null;
  clipboard: { items: string[] } | null;
}

export const STATE: EditorState = {
  enabled: true,
  tool: "select",
  selection: [],
  selected: null,
  selectedId: null,
  idSeq: 1,
  elementIds: new WeakMap(),
  idLookup: new Map(),
  pointer: null,
  resize: null,
  currentSlideIndex: 0,
  suppressNextClick: false,
  slideCheckTimer: null,
  clipboard: null,
};

// Blocks selected as movable PPT-like objects. Text leaves are selected only on
// double-click.
export const BLOCK_SELECTOR = [
  ".html-ppt-created-text",
  ".html-ppt-created-rect",
  ".html-ppt-created-image",
  ".contents-item",
  ".family-card",
  ".product-card",
  ".story-step",
  ".history-event",
  ".hanja-display-card",
  ".ceo-thesis-card",
  "#three-canvas-container",
  ".brewery-layout",
  ".brewery-detail",
  ".brewery-detail-item",
  ".brewery-correction",
  ".story-quote",
  ".info-grid",
  ".ceo-meta",
  ".cover-meta-block",
  ".slide-title",
  ".slide-subtitle",
  ".cover-title",
  ".cover-subtitle",
  ".cover-poetic",
  ".cover-hanja",
  ".contents-title",
  ".contents-eyebrow",
  ".divider-title",
  ".divider-subtitle",
  ".divider-num",
  ".divider-eyebrow",
  ".product-name",
  ".product-price",
  ".product-cat",
  ".step-title",
  ".step-desc",
  ".step-era",
  ".name",
  ".role",
  ".edu",
  ".quote",
  ".card",
  ".box",
  ".panel",
  ".item",
  ".block",
  '[class*="quote" i]',
  '[class*="card" i]',
  '[class*="box" i]',
  '[class*="panel" i]',
  '[class*="item" i]',
  "h1",
  "h2",
  "h3",
  "h4",
  "p",
  "blockquote",
  "cite",
].join(",");

// Global background / decoration layers. These typically live at <body> level
// (outside .slide) and are pointer-events:none behind the slides, so they can't
// be clicked — they're reached only via the background picker (selectById).
export const BACKGROUND_SELECTOR = [
  "#bg-layer",
  "#bg-canvas",
  '[id*="bg" i]',
  '[class*="background" i]',
  '[class*="backdrop" i]',
  '[class*="particle" i]',
  ".glow",
  ".grid-overlay",
  ".noise",
  ".vignette",
  "canvas",
].join(",");

export const NEVER_SELECT_SELECTOR = [
  "script",
  "style",
  "link",
  "meta",
  "html",
  "body",
  ".presentation",
  ".slide",
  ".slide-header",
  ".slide-footer",
  ".progress-bar",
  ".slide-indicator",
  ".nav-hint",
  "#three-canvas-container canvas",
].join(",");
