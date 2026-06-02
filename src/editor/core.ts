// Core editor logic, ported from editor_js/editor_bridge.js.
//
// HARD CONSTRAINTS preserved from the original (do not break these):
//  - never reparent elements and never overwrite `transform` (deck .anim /
//    .in-view animations depend on them);
//  - selection never mutates the DOM (prepareForMove runs lazily on first drag);
//  - text editing rewrites TEXT NODES via TreeWalker, never innerHTML, so nested
//    <strong>/<span>/<cite> survive;
//  - getCleanHtml strips every editor artifact before export;
//  - Edit-OFF is a fully clean presentation view.

import type { Patch, PatchOp } from "@shared/patch-keys";
import type { SelectionPayload, SelectedContext, TextNodeInfo, BackgroundLayer } from "@/types/context";
import type { EditorTool } from "@/types/messages";
import { emit } from "./events";
import { STATE, BLOCK_SELECTOR, NEVER_SELECT_SELECTOR, BACKGROUND_SELECTOR } from "./state";
import { saveState, undo as historyUndo, redo as historyRedo, resetHistory } from "./history";
import {
  ANIMATION_NONE,
  ANIMATION_CSS,
  ANIMATION_DEFAULTS,
  ANIMATION_PRESET_SET,
  keyframeNameFor,
  presetFromKeyframe,
  type AnimationPreset,
} from "@shared/animation-presets";
import type { EditorAction, LayoutOp } from "@shared/actions";
import { BLOCK_TEMPLATES, BLOCK_BASE_CSS, type BlockType } from "@shared/blocks";

// Durable per-element marker for anchoring AI chat threads. Deliberately NOT a
// `data-html-ppt-*` name so getCleanHtml keeps it — it survives undo (it's in the
// snapshot), save/export, and reopen. Assigned only when an object is first
// chatted about (not on mere selection), so clicks never mutate the deck.
const AI_ID_ATTR = "data-ai-id";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function computedNumber(value: unknown, fallback = 0): number {
  const n = Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}

function px(value: unknown): string {
  return `${Math.round(Number(value) || 0)}px`;
}

function cssLength(value: unknown, defaultUnit = "px"): string {
  if (value == null) return "";
  if (typeof value === "number") return `${value}${defaultUnit}`;
  const text = String(value).trim();
  if (!text) return "";
  if (/^-?\d+(\.\d+)?$/.test(text)) return `${text}${defaultUnit}`;
  return text;
}

function cssPxNumber(value: unknown, fallback = 0): number {
  if (value === "auto" || value === "" || value == null) return fallback;
  return computedNumber(value, fallback);
}

function isMediaElement(el: Element | null): boolean {
  return !!(el && ["IMG", "CANVAS", "SVG", "VIDEO", "IFRAME"].includes(el.tagName));
}

function colorLooksVisible(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  return !!v && v !== "transparent" && v !== "rgba(0, 0, 0, 0)" && v !== "rgba(0,0,0,0)";
}

function borderLooksVisible(cs: CSSStyleDeclaration): boolean {
  const widths = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(
    (v) => Number.parseFloat(v) || 0
  );
  const styles = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  return widths.some((w) => w > 0) && ["solid", "dashed", "dotted", "double"].some((s) => styles.includes(s));
}

function normalizedTextNodeValue(node: Node): string {
  return (node.textContent || "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Overlay UI
// ---------------------------------------------------------------------------

export function injectStyle(): void {
  if (document.getElementById("html-ppt-editor-style")) return;
  const style = document.createElement("style");
  style.id = "html-ppt-editor-style";
  style.dataset.htmlPptEditor = "true";
  style.textContent = `
    .html-ppt-editor-ui {
      position: fixed; z-index: 2147483647; pointer-events: none;
      box-sizing: border-box; font-family: Arial, sans-serif;
    }
    #html-ppt-selection-box { display:none; border:2px solid #0a84ff; background:rgba(10,132,255,0.045); }
    .html-ppt-secondary-box {
      display:none; border:2px dashed #0a84ff; background:rgba(10,132,255,0.045);
    }
    #html-ppt-selection-label {
      display:none; background:#0a84ff; color:white; padding:3px 7px; border-radius:4px;
      font-size:11px; line-height:1.2; white-space:nowrap;
    }
    #html-ppt-resize-handle {
      display:none; width:14px; height:14px; border-radius:50%; background:#0a84ff;
      border:2px solid white; box-shadow:0 1px 8px rgba(0,0,0,.25); pointer-events:auto; cursor:nwse-resize;
    }
    #html-ppt-edit-toast {
      display:none; left:50%; top:14px; transform:translateX(-50%); color:white;
      background:rgba(30,30,30,.90); padding:8px 12px; border-radius:8px; font-size:12px;
    }
    [data-html-ppt-live-edit="true"] {
      outline:2px dashed #ff9500 !important; outline-offset:3px !important;
      /* Keep the box from collapsing to nothing when all text is erased. */
      min-width:24px !important; min-height:1.2em !important;
    }
    .html-ppt-created-text {
      position:absolute; min-width:140px; min-height:36px; padding:8px 12px;
      color:var(--text-primary,#111); font-size:28px; font-weight:700; line-height:1.25;
      z-index:60; box-sizing:border-box;
    }
    /* Empty text boxes stay visible (and selectable) while editing. */
    .html-ppt-editor-mode .html-ppt-created-text { outline:1px dashed rgba(130,130,140,.55); outline-offset:2px; }
    .html-ppt-editor-mode .html-ppt-created-text:empty::after,
    [data-html-ppt-live-edit="true"]:empty::after { content:"\\00a0"; }
    .html-ppt-created-rect {
      position:absolute; width:280px; height:150px; border:2px solid var(--accent-gold,#8a7544);
      background:rgba(138,117,68,0.08); z-index:20; box-sizing:border-box;
    }
  `;
  document.head.appendChild(style);
}

export function createOverlay(): void {
  const ids = ["html-ppt-selection-box", "html-ppt-selection-label", "html-ppt-resize-handle", "html-ppt-edit-toast"];
  for (const id of ids) {
    if (document.getElementById(id)) continue;
    const el = document.createElement("div");
    el.id = id;
    el.className = "html-ppt-editor-ui";
    el.dataset.htmlPptEditor = "true";
    document.body.appendChild(el);
  }
}

const box = () => document.getElementById("html-ppt-selection-box");
const label = () => document.getElementById("html-ppt-selection-label");
const handle = () => document.getElementById("html-ppt-resize-handle");
const toastEl = () => document.getElementById("html-ppt-edit-toast");

function log(message: unknown): void {
  emit("log", String(message));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: unknown): void {
  const t = toastEl();
  if (!t) return;
  t.textContent = String(message);
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.style.display = "none";
  }, 1800);
  log(message);
}

function isEditorUi(el: EventTarget | null): boolean {
  const node = el as Element | null;
  return !!(node && node.closest && node.closest('[data-html-ppt-editor="true"]'));
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

function slides(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".slide"));
}

function currentSlide(): HTMLElement {
  const list = slides();
  return list[STATE.currentSlideIndex] || list[0] || document.body;
}

function getSlide(el: Element | null): HTMLElement {
  return ((el && el.closest && el.closest<HTMLElement>(".slide")) || currentSlide()) as HTMLElement;
}

function isSelectableRect(el: Element | null): boolean {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 3 && r.height >= 3;
}

// ---------------------------------------------------------------------------
// Selection targeting
// ---------------------------------------------------------------------------

function isGenericEditableObject(el: Element | null, slide: Element | null): boolean {
  if (!el || !slide || el === slide || el.matches(NEVER_SELECT_SELECTOR)) return false;
  if (!slide.contains(el) || !isSelectableRect(el)) return false;
  if (isMediaElement(el)) return true;
  const cs = window.getComputedStyle(el);
  if (!cs || cs.display === "none" || cs.visibility === "hidden" || cs.display === "contents") return false;
  const r = el.getBoundingClientRect();
  const hasBoxStyle =
    colorLooksVisible(cs.backgroundColor) ||
    borderLooksVisible(cs) ||
    cs.boxShadow !== "none" ||
    Number.parseFloat(cs.borderRadius || "0") > 0;
  const hasClass = String(el.className || "").trim().length > 0;
  const hasMeaningfulSize = r.width >= 10 && r.height >= 10;
  const textTag = ["H1", "H2", "H3", "H4", "H5", "H6", "P", "BLOCKQUOTE", "CITE", "LI", "TD", "TH", "SPAN", "STRONG", "EM"].includes(
    el.tagName
  );
  const blockLike = ["DIV", "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER", "MAIN", "UL", "OL"].includes(el.tagName);
  return (
    hasMeaningfulSize &&
    (textTag || hasBoxStyle || hasClass || (blockLike && (el.children.length > 0 || ((el as HTMLElement).innerText || "").trim().length > 0)))
  );
}

function normalizeTarget(el: Element | null): HTMLElement | null {
  let node: Element | null = el;
  if (!node || isEditorUi(node)) return null;
  if (node.nodeType !== 1) node = (node as Node).parentElement;
  if (!node || !node.closest) return null;

  const threeContainer = node.closest<HTMLElement>("#three-canvas-container");
  if (threeContainer && threeContainer.closest(".slide") && isSelectableRect(threeContainer)) {
    return threeContainer;
  }

  if (node.matches && node.matches(NEVER_SELECT_SELECTOR)) return null;
  const slide = node.closest(".slide");
  if (!slide) return null;

  const candidate = node.closest<HTMLElement>(BLOCK_SELECTOR);
  if (
    candidate &&
    slide.contains(candidate) &&
    candidate !== slide &&
    !candidate.matches(NEVER_SELECT_SELECTOR) &&
    isSelectableRect(candidate)
  ) {
    return candidate;
  }

  let cur: Element | null = node;
  while (cur && cur !== slide && cur !== document.body) {
    if (isGenericEditableObject(cur, slide)) return cur as HTMLElement;
    cur = cur.parentElement;
  }
  return null;
}

function normalizeTextTarget(el: Element | null): HTMLElement | null {
  let node: Element | null = el;
  if (!node || isEditorUi(node)) return null;
  if (node.nodeType !== 1) node = (node as Node).parentElement;
  if (!node || !node.closest || !node.closest(".slide")) return null;
  let cur: Element | null = node;
  while (cur && cur.closest && cur.closest(".slide") && cur !== document.body) {
    const html = cur as HTMLElement;
    if (isEditableTextElement(cur) && html.innerText && html.innerText.trim().length > 0) return html;
    cur = cur.parentElement;
  }
  return null;
}

function runtimeId(el: Element): string {
  if (!STATE.elementIds.has(el)) {
    const id = "runtime_el_" + String(STATE.idSeq++).padStart(5, "0");
    STATE.elementIds.set(el, id);
    STATE.idLookup.set(id, el);
  }
  return STATE.elementIds.get(el)!;
}

// ---------------------------------------------------------------------------
// Geometry / text nodes
// ---------------------------------------------------------------------------

interface LocalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function localRect(el: Element): LocalRect {
  const r = el.getBoundingClientRect();
  const sr = getSlide(el).getBoundingClientRect();
  return { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height };
}

function isForbiddenTextNodeParent(el: Element | null): boolean {
  return !!(el && el.closest && el.closest('script, style, noscript, template, [data-html-ppt-editor="true"]'));
}

function textNodesFor(el: Element | null): Text[] {
  if (!el || isMediaElement(el)) return [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (!node || !node.parentElement || isForbiddenTextNodeParent(node.parentElement)) {
        return NodeFilter.FILTER_REJECT;
      }
      const value = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!value) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

function isTextSafe(el: Element | null): boolean {
  if (!el || isMediaElement(el)) return false;
  return textNodesFor(el).length > 0;
}

function isEditableTextElement(el: Element | null): boolean {
  return isTextSafe(el);
}

function getEditableText(el: Element | null): string {
  if (!el) return "";
  return textNodesFor(el).map(normalizedTextNodeValue).filter(Boolean).join("\n");
}

function setTextNodePreservingOuterWhitespace(node: Node, value: string): void {
  const original = node.textContent || "";
  const leading = (original.match(/^\s*/) || [""])[0];
  const trailing = (original.match(/\s*$/) || [""])[0];
  node.textContent = leading + String(value ?? "") + trailing;
}

function setEditableText(el: Element | null, value: string): boolean {
  if (!el || !isEditableTextElement(el)) return false;
  const nodes = textNodesFor(el);
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

// ---------------------------------------------------------------------------
// Payload / context
// ---------------------------------------------------------------------------

function payload(el: HTMLElement | null): SelectionPayload {
  if (!el) return {};
  const r = localRect(el);
  const cs = window.getComputedStyle(el);
  const slideIndex = slides().indexOf(getSlide(el)) + 1;
  return {
    id: runtimeId(el),
    tag: el.tagName.toLowerCase(),
    className: String(el.className || ""),
    slideIndex,
    totalSlides: slides().length,
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.w),
    h: Math.round(r.h),
    fontSize: Math.round(computedNumber(cs.fontSize, 14)),
    color: cs.color || "",
    backgroundColor: cs.backgroundColor || "",
    borderColor: cs.borderColor || "",
    position: cs.position || "",
    text: getEditableText(el),
    textSafe: isEditableTextElement(el),
    // Read the inline animation only (not computed) so we reflect an editor-set
    // preset, never a deck's own CSS animation.
    animationName: presetFromKeyframe(el.style.animationName),
    childElementCount: el.children.length,
    zIndex: computedNumber(cs.zIndex, 0),
    positioned: el.getAttribute("data-html-ppt-positioned") === "true",
    stableId: el.getAttribute(AI_ID_ATTR) || undefined,
  };
}

function selectedContext(): SelectedContext | null {
  return STATE.selected ? contextFor(STATE.selected) : null;
}

function contextFor(el: HTMLElement): SelectedContext {
  const base = payload(el);
  const cs = window.getComputedStyle(el);
  const slide = getSlide(el);
  const parent = el.parentElement;
  const textNodes: TextNodeInfo[] = textNodesFor(el).map((node, index) => ({
    index,
    text: normalizedTextNodeValue(node),
    parentTag: node.parentElement ? node.parentElement.tagName.toLowerCase() : "",
    parentClass: node.parentElement ? String(node.parentElement.className || "") : "",
  }));
  return {
    ...base,
    innerText: (el.innerText || "").slice(0, 4000),
    outerHTML: (el.outerHTML || "").slice(0, 8000),
    inlineStyle: el.getAttribute("style") || "",
    parentTag: parent ? parent.tagName.toLowerCase() : "",
    parentClass: parent ? String(parent.className || "") : "",
    slideClass: slide ? String(slide.className || "") : "",
    slideDataset: slide ? ({ ...(slide as HTMLElement).dataset } as Record<string, string>) : {},
    textNodes,
    computedStyle: {
      position: cs.position,
      display: cs.display,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      borderWidth: cs.borderWidth,
      borderStyle: cs.borderStyle,
      borderRadius: cs.borderRadius,
      opacity: cs.opacity,
      zIndex: cs.zIndex,
      filter: cs.filter,
    },
  };
}

// Contexts for every selected object (multi-object AI). Each carries its own id.
function getSelectionContexts(): SelectedContext[] {
  return STATE.selection.filter((el) => document.body.contains(el)).map((el) => contextFor(el));
}

// Global background / decoration layers (the animated background lives here).
// They sit outside .slide and are usually pointer-events:none behind the slides,
// so they can't be clicked — the shell lists them and selects one by id instead.
function listBackgroundLayers(): BackgroundLayer[] {
  const seen = new Set<Element>();
  const out: BackgroundLayer[] = [];
  document.querySelectorAll<HTMLElement>(BACKGROUND_SELECTOR).forEach((el) => {
    if (seen.has(el) || el.closest(".slide") || isEditorUi(el)) return;
    seen.add(el);
    const cs = window.getComputedStyle(el);
    if (cs.display === "none") return;
    const cls = String(el.className || "").split(" ").filter(Boolean).slice(0, 2).join(".");
    const label = `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : cls ? "." + cls : ""}`;
    const r = el.getBoundingClientRect();
    out.push({ id: runtimeId(el), label, w: Math.round(r.width), h: Math.round(r.height) });
  });
  return out;
}

function selectById(id: string): boolean {
  const el = STATE.idLookup.get(String(id)) as HTMLElement | undefined;
  if (!el || !document.body.contains(el)) return false;
  return selectElement(el, { raw: true });
}

// Ensure every selected element has a durable data-ai-id (assigning a new one if
// missing) and return them in selection order. Called when the user first chats
// about an object, so the thread can be anchored to a marker that outlives the
// volatile runtime id. Emits a fresh selection so the shell sees the new ids.
function assignStableIds(): string[] {
  const ids: string[] = [];
  let assigned = false;
  for (const el of STATE.selection) {
    let aid = el.getAttribute(AI_ID_ATTR);
    if (!aid) {
      aid = "a" + Math.random().toString(36).slice(2, 9);
      el.setAttribute(AI_ID_ATTR, aid);
      assigned = true;
    }
    ids.push(aid);
  }
  if (assigned) emitSelection();
  return ids;
}

// PNG data URL of the primary selection (for img2img "make it fancier"). Deck
// assets load as same-origin blob URLs, so the canvas isn't tainted; a tainted
// (cross-origin) canvas throws on toDataURL -> null, and the server falls back
// to text-only generation.
function getSelectedImageData(): string | null {
  const el = STATE.selected;
  if (!el) return null;
  try {
    if (el.tagName === "IMG") {
      const img = el as HTMLImageElement;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) return null;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/png");
    }
    if (el.tagName === "CANVAS") return (el as HTMLCanvasElement).toDataURL("image/png");
  } catch {
    return null;
  }
  return null;
}

// Primary payload (back-compat for the Inspector) augmented with multi-selection
// info the shell uses to gate AI and show "N selected".
function selectionPayload(): SelectionPayload {
  return {
    ...payload(STATE.selected),
    selectionCount: STATE.selection.length,
    selectionIds: STATE.selection.map((el) => runtimeId(el)),
    // Durable per-element markers (null until the object is first chatted about).
    selectionStableIds: STATE.selection.map((el) => el.getAttribute(AI_ID_ATTR)),
  };
}
function emitSelection(): void {
  emit("selection", selectionPayload());
}
function emitMutation(): void {
  emit("mutation", selectionPayload());
}
function emitSlideChanged(): void {
  emit("slide", { current: STATE.currentSlideIndex + 1, total: slides().length });
}

// ---------------------------------------------------------------------------
// Overlay positioning + selection
// ---------------------------------------------------------------------------

const SECONDARY_BOX_CLASS = "html-ppt-secondary-box";

function secondaryBoxes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("." + SECONDARY_BOX_CLASS));
}

// Grow the secondary-outline pool to at least `count` boxes.
function ensureSecondaryBoxes(count: number): HTMLElement[] {
  const pool = secondaryBoxes();
  while (pool.length < count) {
    const el = document.createElement("div");
    el.className = "html-ppt-editor-ui " + SECONDARY_BOX_CLASS;
    el.dataset.htmlPptEditor = "true";
    document.body.appendChild(el);
    pool.push(el);
  }
  return pool;
}

function updateOverlay(): void {
  const b = box(),
    l = label(),
    h = handle();
  if (!b || !l || !h) return;
  const pool = secondaryBoxes();
  const hideAll = () => {
    b.style.display = l.style.display = h.style.display = "none";
    pool.forEach((p) => (p.style.display = "none"));
  };
  const primary = STATE.selected;
  if (!STATE.enabled || !primary || !document.body.contains(primary)) return hideAll();
  const r = primary.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return hideAll();

  b.style.display = "block";
  b.style.left = px(r.left);
  b.style.top = px(r.top);
  b.style.width = px(r.width);
  b.style.height = px(r.height);

  const others = STATE.selection.filter((el) => el !== primary && document.body.contains(el));

  const cls = String(primary.className || "").split(" ").filter(Boolean).slice(0, 2).join(".");
  l.textContent = `${primary.tagName.toLowerCase()}${cls ? "." + cls : ""}${others.length ? `  +${others.length}` : ""}`;
  l.style.display = "block";
  l.style.left = px(r.left);
  l.style.top = px(Math.max(0, r.top - 24));

  // The resize handle only makes sense for a single element.
  if (others.length === 0) {
    h.style.display = "block";
    h.style.left = px(r.right - 7);
    h.style.top = px(r.bottom - 7);
  } else {
    h.style.display = "none";
  }

  const boxes = ensureSecondaryBoxes(others.length);
  others.forEach((el, i) => {
    const rr = el.getBoundingClientRect();
    const sb = boxes[i];
    if (rr.width < 1 || rr.height < 1) {
      sb.style.display = "none";
      return;
    }
    sb.style.display = "block";
    sb.style.left = px(rr.left);
    sb.style.top = px(rr.top);
    sb.style.width = px(rr.width);
    sb.style.height = px(rr.height);
  });
  for (let i = others.length; i < boxes.length; i++) boxes[i].style.display = "none";
}

// The primary/anchor is always the last element of the selection.
function syncPrimary(): void {
  const primary = STATE.selection[STATE.selection.length - 1] ?? null;
  STATE.selected = primary;
  STATE.selectedId = primary ? runtimeId(primary) : null;
}

// Replace the whole selection (de-duped, detached nodes dropped) and refresh.
function setSelection(els: HTMLElement[]): void {
  const seen = new Set<HTMLElement>();
  const next: HTMLElement[] = [];
  for (const el of els) {
    if (el && document.body.contains(el) && !seen.has(el)) {
      seen.add(el);
      next.push(el);
    }
  }
  STATE.selection = next;
  syncPrimary();
  updateOverlay();
  emitSelection();
}

function selectElement(el: Element | null, options: { raw?: boolean; additive?: boolean } = {}): boolean {
  const target = options.raw ? (el as HTMLElement) : normalizeTarget(el);
  if (!target) return false;
  if (options.additive) {
    const idx = STATE.selection.indexOf(target);
    if (idx >= 0) {
      // Toggle out of the selection; finish text editing if it was the editor.
      if (target.getAttribute("data-html-ppt-live-edit") === "true") finishTextEdit(true);
      const next = STATE.selection.slice();
      next.splice(idx, 1);
      setSelection(next);
    } else {
      setSelection([...STATE.selection, target]);
    }
  } else {
    setSelection([target]);
  }
  return true;
}

function deselect(): void {
  if (STATE.selected && STATE.selected.getAttribute("data-html-ppt-live-edit") === "true") {
    finishTextEdit(true);
  }
  setSelection([]);
}

function isEditorCreated(el: Element | null): boolean {
  return !!(el && el.classList && (el.classList.contains("html-ppt-created-text") || el.classList.contains("html-ppt-created-rect")));
}

// ---------------------------------------------------------------------------
// Move / resize — never reparents, never sets transform
// ---------------------------------------------------------------------------

function prepareForMove(el: HTMLElement | null): void {
  if (!STATE.enabled || !el) return;
  const cs = window.getComputedStyle(el);
  if (cs.position === "static") el.style.position = "relative";
  if (!el.style.left || el.style.left === "auto") el.style.left = "0px";
  if (!el.style.top || el.style.top === "auto") el.style.top = "0px";
  if (isEditorCreated(el)) {
    if (!el.style.width) el.style.width = px(Math.max(20, localRect(el).w));
    if (!el.style.height) el.style.height = px(Math.max(20, localRect(el).h));
  }
  el.style.boxSizing = "border-box";
  if (!el.style.zIndex || el.style.zIndex === "auto") {
    const zi = computedNumber(cs.zIndex, 10);
    el.style.zIndex = String(Math.max(10, zi));
  }
  el.setAttribute("data-html-ppt-positioned", "true");
}

function moveBy(el: HTMLElement | null, dx: number, dy: number): void {
  if (!STATE.enabled || !el) return;
  prepareForMove(el);
  const left = cssPxNumber(el.style.left, 0);
  const top = cssPxNumber(el.style.top, 0);
  el.style.left = px(left + dx);
  el.style.top = px(top + dy);
}

function refreshInteractiveScenes(): void {
  try {
    window.dispatchEvent(new Event("resize"));
  } catch {
    /* noop */
  }
}

function setLocalPosition(el: HTMLElement | null, targetX: number, targetY: number): void {
  if (!STATE.enabled || !el) return;
  prepareForMove(el);
  const r = localRect(el);
  moveBy(el, (Number(targetX) || 0) - r.x, (Number(targetY) || 0) - r.y);
}

function slidePointFromEvent(e: MouseEvent): { slide: HTMLElement; x: number; y: number } {
  const fromPoint = document.elementFromPoint(e.clientX, e.clientY);
  const slide = ((fromPoint && fromPoint.closest && fromPoint.closest<HTMLElement>(".slide")) || currentSlide()) as HTMLElement;
  const sr = slide.getBoundingClientRect();
  return { slide, x: Math.max(0, e.clientX - sr.left), y: Math.max(0, e.clientY - sr.top) };
}

function insertTextBoxAt(e: MouseEvent): void {
  if (!STATE.enabled) return;
  saveState();
  const p = slidePointFromEvent(e);
  const el = document.createElement("div");
  el.className = "html-ppt-created-text";
  el.textContent = "New Text";
  el.style.left = px(p.x);
  el.style.top = px(p.y);
  el.style.width = "360px";
  el.style.height = "56px";
  el.setAttribute("data-html-ppt-positioned", "true");
  p.slide.appendChild(el);
  selectElement(el, { raw: true });
  startTextEdit(el, false); // insert already recorded history
  emitMutation();
}

function insertRectAt(e: MouseEvent): void {
  if (!STATE.enabled) return;
  saveState();
  const p = slidePointFromEvent(e);
  const el = document.createElement("div");
  el.className = "html-ppt-created-rect";
  el.style.left = px(p.x);
  el.style.top = px(p.y);
  el.setAttribute("data-html-ppt-positioned", "true");
  p.slide.appendChild(el);
  selectElement(el, { raw: true });
  emitMutation();
}

function startTextEdit(el: HTMLElement, recordHistory = true): void {
  if (!STATE.enabled) return;
  if (!isEditableTextElement(el)) {
    toast("Text edit blocked: selected object has no visible text node.");
    return;
  }
  // One undo snapshot per edit session (before any keystroke).
  if (recordHistory) saveState();
  selectElement(el, { raw: true });
  el.setAttribute("contenteditable", "true");
  el.setAttribute("data-html-ppt-live-edit", "true");
  el.focus({ preventScroll: true });
  updateOverlay();
  emitSelection();
}

function finishTextEdit(doEmit = true): void {
  const el = STATE.selected;
  if (!el) return;
  el.removeAttribute("contenteditable");
  el.removeAttribute("data-html-ppt-live-edit");
  updateOverlay();
  if (doEmit) emitMutation();
}

// ---------------------------------------------------------------------------
// Pointer / keyboard handlers
// ---------------------------------------------------------------------------

function onMouseDown(e: MouseEvent): void {
  if (!STATE.enabled || e.button !== 0) return;
  if (isEditorUi(e.target)) return;

  if (STATE.tool === "text") {
    insertTextBoxAt(e);
    STATE.tool = "select";
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (STATE.tool === "rect") {
    insertRectAt(e);
    STATE.tool = "select";
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const target = normalizeTarget(e.target as Element);
  if (!target) return;

  // Pressing (without a modifier) on a member of an existing multi-selection must
  // NOT collapse the selection yet — that would break dragging the whole group.
  // Keep the selection; a plain click with no drag collapses it later in onClick.
  const pressInMulti = !additive && STATE.selection.length > 1 && STATE.selection.includes(target);
  if (!pressInMulti) selectElement(target, { raw: true, additive });

  if (target.isContentEditable) return;
  // If an additive click toggled the target OUT of the selection, don't drag.
  if (!STATE.selection.includes(target)) return;

  const r = localRect(target);
  STATE.pointer = {
    target,
    startClientX: e.clientX,
    startClientY: e.clientY,
    startX: r.x,
    startY: r.y,
    didDrag: false,
    group: [],
  };
}

function onMouseMove(e: MouseEvent): void {
  if (!STATE.enabled) return;

  if (STATE.resize && STATE.selected) {
    const dx = e.clientX - STATE.resize.startClientX;
    const dy = e.clientY - STATE.resize.startClientY;
    STATE.selected.style.width = px(Math.max(20, STATE.resize.startW + dx));
    STATE.selected.style.height = px(Math.max(20, STATE.resize.startH + dy));
    updateOverlay();
    emitMutation();
    refreshInteractiveScenes();
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (STATE.pointer && STATE.selection.includes(STATE.pointer.target)) {
    const dx = e.clientX - STATE.pointer.startClientX;
    const dy = e.clientY - STATE.pointer.startClientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 5) {
      if (!STATE.pointer.didDrag) {
        saveState(); // one snapshot per drag gesture
        // Capture every selected element's start position so the whole
        // selection moves together by the same delta.
        STATE.pointer.group = STATE.selection.map((el) => {
          prepareForMove(el);
          return { el, startX: cssPxNumber(el.style.left, 0), startY: cssPxNumber(el.style.top, 0) };
        });
        STATE.pointer.didDrag = true;
        STATE.suppressNextClick = true;
      }
      for (const g of STATE.pointer.group) {
        g.el.style.left = px(g.startX + dx);
        g.el.style.top = px(g.startY + dy);
      }
      updateOverlay();
      emitMutation();
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

function onMouseUp(e: MouseEvent): void {
  if (STATE.resize) {
    emitMutation();
    e.preventDefault();
    e.stopPropagation();
  }
  if (STATE.pointer && STATE.pointer.didDrag) {
    emitMutation();
    e.preventDefault();
    e.stopPropagation();
    setTimeout(() => {
      STATE.suppressNextClick = false;
    }, 0);
  }
  STATE.pointer = null;
  STATE.resize = null;
}

function onClick(e: MouseEvent): void {
  if (!STATE.enabled || isEditorUi(e.target)) return;
  if (STATE.suppressNextClick) {
    e.preventDefault();
    e.stopPropagation();
    STATE.suppressNextClick = false;
    return;
  }
  if (STATE.tool !== "select") return;
  // Additive (shift/ctrl/⌘) toggles were already handled on mousedown; doing it
  // again here would cancel the toggle.
  if (e.shiftKey || e.metaKey || e.ctrlKey) return;
  const target = normalizeTarget(e.target as Element);
  if (target) {
    selectElement(target, { raw: true });
  } else if (STATE.selected) {
    // Click on empty slide background clears the selection, so arrow/scroll
    // navigation works again immediately (PowerPoint-style).
    deselect();
  }
}

function onDoubleClick(e: MouseEvent): void {
  if (!STATE.enabled || isEditorUi(e.target)) return;
  const target = normalizeTextTarget(e.target as Element);
  if (!target) {
    toast("No safe text leaf found here. Try double-clicking the exact text itself.");
    return;
  }
  startTextEdit(target);
  e.preventDefault();
  e.stopPropagation();
}

function activeEditableElement(): HTMLElement | null {
  const active = document.activeElement as Element | null;
  if (active && active.closest) {
    const activeEditable = active.closest<HTMLElement>('[contenteditable="true"]');
    if (activeEditable) return activeEditable;
  }
  return null;
}

function eventEditableElement(e: KeyboardEvent): HTMLElement | null {
  const target = e.target as Element | null;
  if (target && target.closest) {
    const targetEditable = target.closest<HTMLElement>('[contenteditable="true"]');
    if (targetEditable) return targetEditable;
  }
  return activeEditableElement();
}

function onKeyDown(e: KeyboardEvent): void {
  if (!STATE.enabled) return;

  const editingEl = eventEditableElement(e);
  if (editingEl) {
    if (STATE.selected !== editingEl) selectElement(editingEl, { raw: true });
    if (e.key === "Escape") {
      finishTextEdit(true);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // While editing text, let the browser handle keys natively (incl. native
    // Ctrl+Z text undo). Just stop the deck's nav shortcuts from firing.
    e.stopImmediatePropagation();
    return;
  }

  const mod = e.ctrlKey || e.metaKey;

  if (mod) {
    const k = e.key.toLowerCase();
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (k === "z") {
      if (e.shiftKey) editorApi.redo();
      else editorApi.undo();
      stop();
      return;
    }
    if (k === "y") {
      editorApi.redo();
      stop();
      return;
    }
    if (k === "c") {
      if (STATE.selected) {
        copySelected();
        stop();
      }
      return;
    }
    if (k === "x") {
      if (STATE.selected) {
        cutSelected();
        stop();
      }
      return;
    }
    if (k === "v") {
      if (STATE.clipboard) {
        pasteClipboard();
        stop();
      }
      return;
    }
    if (k === "d") {
      if (STATE.selected) {
        editorApi.duplicateSelected();
        stop();
      }
      return;
    }
    if (e.key === "]") {
      if (STATE.selected) {
        editorApi.bringFront();
        stop();
      }
      return;
    }
    if (e.key === "[") {
      if (STATE.selected) {
        editorApi.sendBack();
        stop();
      }
      return;
    }
    return;
  }

  if (e.key === "Escape") {
    deselect();
    e.preventDefault();
    return;
  }

  if ((e.key === "Delete" || e.key === "Backspace") && STATE.selected) {
    editorApi.deleteSelected();
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // Arrow keys nudge the selected object (PowerPoint-style). With nothing
  // selected, arrows fall through to the deck's own slide navigation.
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) && STATE.selected) {
    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const [ddx, ddy] = delta[e.key];
    nudgeSelected(ddx, ddy);
    e.preventDefault();
    e.stopPropagation();
  }
}

function onInput(e: Event): void {
  if (STATE.selected && e.target === STATE.selected && STATE.selected.isContentEditable) {
    updateOverlay();
    emitMutation();
  }
}

// ---------------------------------------------------------------------------
// Slide tracking
// ---------------------------------------------------------------------------

function visibilityRatio(el: Element | null): number {
  if (!el || !el.getBoundingClientRect) return 0;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 1;
  const vh = window.innerHeight || document.documentElement.clientHeight || 1;
  const x1 = Math.max(0, r.left);
  const y1 = Math.max(0, r.top);
  const x2 = Math.min(vw, r.right);
  const y2 = Math.min(vh, r.bottom);
  const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const total = Math.max(1, r.width * r.height);
  return area / total;
}

function bestVisibleSlide(): { slide: HTMLElement; index: number; ratio: number } | null {
  const list = slides();
  if (!list.length) return null;
  let bestIndex = 0;
  let bestRatio = -1;
  list.forEach((slide, idx) => {
    const ratio = visibilityRatio(slide);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestIndex = idx;
    }
  });
  return { slide: list[bestIndex], index: bestIndex, ratio: bestRatio };
}

function replaySlideAnimation(slide: HTMLElement | null): void {
  if (!slide || !slide.classList) return;
  // While text is being edited we must NOT do the remove-then-re-add restart:
  // it would interrupt the active animation and steal focus. But we still have
  // to guarantee the slide is revealed — otherwise navigating away from an
  // editing session leaves the new slide's .anim elements stuck at opacity:0
  // ("contents gone besides the background"). So just ensure .in-view is on.
  if (activeEditableElement()) {
    slide.classList.add("in-view");
    return;
  }
  if (slide.getAttribute("data-html-ppt-replay-lock") === "true") return;
  slide.setAttribute("data-html-ppt-replay-lock", "true");
  slide.classList.remove("in-view");
  void slide.offsetWidth; // force reflow so the re-add restarts transitions
  requestAnimationFrame(() => {
    slide.classList.add("in-view");
    setTimeout(() => slide.removeAttribute("data-html-ppt-replay-lock"), 220);
  });
}

function updateCurrentSlideFromViewport(replay = false): void {
  const info = bestVisibleSlide();
  if (!info) return;
  const list = slides();
  if (info.index !== STATE.currentSlideIndex) {
    const previous = list[STATE.currentSlideIndex];
    if (previous && previous !== info.slide) previous.classList.remove("in-view");
    STATE.currentSlideIndex = info.index;
    emitSlideChanged();
    updateOverlay();
    if (replay) replaySlideAnimation(info.slide);
  }
}

function scheduleSlideCheck(replay = true): void {
  if (STATE.slideCheckTimer) clearTimeout(STATE.slideCheckTimer);
  STATE.slideCheckTimer = setTimeout(() => updateCurrentSlideFromViewport(replay), 80);
}

function observeSlide(): void {
  const list = slides();
  if (!list.length) return;
  updateCurrentSlideFromViewport(false);
  if (typeof IntersectionObserver === "undefined") return;
  const observer = new IntersectionObserver(() => scheduleSlideCheck(true), {
    threshold: [0.05, 0.3, 0.5, 0.8, 0.95],
  });
  list.forEach((s) => observer.observe(s));
}

function goToSlide(index: number): void {
  const list = slides();
  if (!list.length) return;
  const clamped = Math.max(0, Math.min(list.length - 1, Number(index) || 0));
  const previous = list[STATE.currentSlideIndex];
  if (previous && previous !== list[clamped]) previous.classList.remove("in-view");
  list[clamped].scrollIntoView({ behavior: "smooth", block: "start" });
  STATE.currentSlideIndex = clamped;
  emitSlideChanged();
  updateOverlay();
  setTimeout(() => replaySlideAnimation(list[clamped]), 360);
  setTimeout(() => updateCurrentSlideFromViewport(false), 420);
}

// ---------------------------------------------------------------------------
// Clean HTML export
// ---------------------------------------------------------------------------

function cleanHtml(): string {
  if (STATE.selected && STATE.selected.isContentEditable) finishTextEdit(false);
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.classList.remove("html-ppt-editor-mode");
  const cleanBody = clone.querySelector("body");
  if (cleanBody) cleanBody.classList.remove("html-ppt-editor-mode");
  clone.querySelectorAll('[data-html-ppt-editor="true"], #html-ppt-editor-style').forEach((n) => n.remove());
  clone.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
  clone.querySelectorAll("[data-html-ppt-live-edit]").forEach((n) => n.removeAttribute("data-html-ppt-live-edit"));
  clone.querySelectorAll("[data-html-ppt-positioned]").forEach((n) => n.removeAttribute("data-html-ppt-positioned"));
  clone.querySelectorAll("[data-html-ppt-replay-lock]").forEach((n) => n.removeAttribute("data-html-ppt-replay-lock"));
  return "<!DOCTYPE html>\n" + clone.outerHTML;
}

// ---------------------------------------------------------------------------
// Clipboard + nudge
// ---------------------------------------------------------------------------

function cleanCloneHtml(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.removeAttribute("contenteditable");
  clone.removeAttribute("data-html-ppt-live-edit");
  clone.removeAttribute(AI_ID_ATTR); // a pasted copy is a new object → its own thread
  return clone.outerHTML;
}

function copySelected(): void {
  if (!STATE.enabled || !STATE.selection.length) return;
  STATE.clipboard = { items: STATE.selection.map(cleanCloneHtml) };
  toast(STATE.selection.length > 1 ? `Copied ${STATE.selection.length}` : "Copied");
}

function cutSelected(): void {
  if (!STATE.enabled || !STATE.selection.length) return;
  STATE.clipboard = { items: STATE.selection.map(cleanCloneHtml) };
  editorApi.deleteSelected(); // records history + emits
  toast("Cut");
}

function pasteClipboard(): void {
  if (!STATE.enabled || !STATE.clipboard || !STATE.clipboard.items.length) return;
  saveState();
  const slide = STATE.selected ? getSlide(STATE.selected) : currentSlide();
  const pasted: HTMLElement[] = [];
  for (const html of STATE.clipboard.items) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const node = tpl.content.firstElementChild as HTMLElement | null;
    if (!node) continue;
    slide.appendChild(node);
    if (window.getComputedStyle(node).position === "static") node.style.position = "relative";
    node.setAttribute("data-html-ppt-positioned", "true");
    node.style.left = px(cssPxNumber(node.style.left, 0) + 24);
    node.style.top = px(cssPxNumber(node.style.top, 0) + 24);
    pasted.push(node);
  }
  if (!pasted.length) return;
  setSelection(pasted);
  emitMutation();
  toast(pasted.length > 1 ? `Pasted ${pasted.length}` : "Pasted");
}

let lastNudgeTs = 0;
function nudgeSelected(dx: number, dy: number): void {
  if (!STATE.enabled || !STATE.selection.length) return;
  // Coalesce a burst of arrow taps into a single undo step.
  const now = Date.now();
  if (now - lastNudgeTs > 500) saveState();
  lastNudgeTs = now;
  for (const el of STATE.selection) {
    prepareForMove(el);
    el.style.left = px(computedNumber(el.style.left) + dx);
    el.style.top = px(computedNumber(el.style.top) + dy);
  }
  updateOverlay();
  emitMutation();
}

// ---------------------------------------------------------------------------
// applyPatch — the single mutation funnel (Inspector + AI both land here)
// ---------------------------------------------------------------------------

// Only true geometry keys require prepareForMove (which pins position/left/top).
// Style-only edits (color, opacity, filter, …) must NOT reposition the element —
// important for global background layers that are position:fixed full-bleed.
const MOVE_KEYS: (keyof Patch)[] = ["x", "y", "w", "h"];

// The persistence seam. The keyframe library is injected into the DECK (not the
// editor-UI style) the first time any animation is applied, under
// <style id="html-ppt-animations"> — which carries NEITHER the
// data-html-ppt-editor marker NOR the editor-style id, so cleanHtml() KEEPS it
// and exported decks stay self-contained. It lives in <head>, so undo (which
// only restores slide innerHTML) never drops it. Idempotent by id, so reopening
// a deck that already ships the block doesn't duplicate it.
const ANIMATION_STYLE_ID = "html-ppt-animations";
function ensureAnimationStyles(): void {
  if (document.getElementById(ANIMATION_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = ANIMATION_STYLE_ID;
  style.textContent = ANIMATION_CSS;
  document.head.appendChild(style);
}

const ANIMATION_KEYS: (keyof Patch)[] = [
  "animationName",
  "animationDuration",
  "animationDelay",
  "animationTimingFunction",
  "animationIterationCount",
];

// Apply the animation slice of a patch. `animationName:"none"` clears every
// animation longhand (removes motion). Otherwise we map the friendly preset to
// its namespaced @keyframes, backfill a sensible duration/iteration when the
// patch sets a name but omits them, and force one reflow so the animation
// (re)plays immediately on apply — even when re-selecting the same preset.
function applyAnimation(sel: HTMLElement, patch: Patch): void {
  const touchesAnimation = ANIMATION_KEYS.some((k) => patch[k] !== undefined);
  if (!touchesAnimation) return;

  if (patch.animationName !== undefined && String(patch.animationName) === ANIMATION_NONE) {
    sel.style.animationName = "";
    sel.style.animationDuration = "";
    sel.style.animationDelay = "";
    sel.style.animationTimingFunction = "";
    sel.style.animationIterationCount = "";
    sel.style.animationFillMode = "";
    return;
  }

  ensureAnimationStyles();

  if (patch.animationName !== undefined && ANIMATION_PRESET_SET.has(String(patch.animationName))) {
    const preset = String(patch.animationName) as AnimationPreset;
    const def = ANIMATION_DEFAULTS[preset];
    // Restart cleanly so the animation visibly plays even if the name is unchanged.
    sel.style.animationName = "none";
    void sel.offsetWidth; // force reflow
    sel.style.animationName = keyframeNameFor(preset);
    sel.style.animationFillMode = "both";
    // Backfill timing only when this patch doesn't set it and nothing is inline yet.
    if (patch.animationDuration === undefined && !sel.style.animationDuration)
      sel.style.animationDuration = def.duration;
    if (patch.animationIterationCount === undefined && !sel.style.animationIterationCount)
      sel.style.animationIterationCount = def.iterationCount;
  }

  if (patch.animationDuration !== undefined) sel.style.animationDuration = String(patch.animationDuration);
  if (patch.animationDelay !== undefined) sel.style.animationDelay = String(patch.animationDelay);
  if (patch.animationTimingFunction !== undefined)
    sel.style.animationTimingFunction = String(patch.animationTimingFunction);
  if (patch.animationIterationCount !== undefined)
    sel.style.animationIterationCount = String(patch.animationIterationCount);
}

// Mutate ONE element from a sanitized patch. No history/emit — the caller owns
// the saveState() snapshot and the mutation event so multi-object edits collapse
// into a single undo step and a single repaint.
function applyPatchToElement(sel: HTMLElement, patch: Patch): void {
  if (MOVE_KEYS.some((k) => patch[k] !== undefined)) prepareForMove(sel);

  if (patch.x !== undefined || patch.y !== undefined) {
    const r = localRect(sel);
    setLocalPosition(sel, patch.x !== undefined ? Number(patch.x) : r.x, patch.y !== undefined ? Number(patch.y) : r.y);
  }
  if (patch.w !== undefined) {
    sel.style.width = px(Math.max(20, Number(patch.w) || 20));
    refreshInteractiveScenes();
  }
  if (patch.h !== undefined) {
    sel.style.height = px(Math.max(20, Number(patch.h) || 20));
    refreshInteractiveScenes();
  }
  if (patch.fontSize !== undefined) sel.style.fontSize = px(Math.max(1, Number(patch.fontSize) || 1));
  if (patch.color !== undefined && String(patch.color).trim()) sel.style.color = String(patch.color).trim();
  if (patch.backgroundColor !== undefined && String(patch.backgroundColor).trim())
    sel.style.backgroundColor = String(patch.backgroundColor).trim();
  if (patch.borderColor !== undefined && String(patch.borderColor).trim()) {
    sel.style.borderColor = String(patch.borderColor).trim();
    if (!sel.style.borderStyle || sel.style.borderStyle === "none") sel.style.borderStyle = "solid";
    if (!sel.style.borderWidth) sel.style.borderWidth = "2px";
  }
  if (patch.borderWidth !== undefined && String(patch.borderWidth).trim())
    sel.style.borderWidth = cssLength(patch.borderWidth, "px");
  if (patch.borderStyle !== undefined && String(patch.borderStyle).trim())
    sel.style.borderStyle = String(patch.borderStyle).trim();
  if (patch.borderRadius !== undefined && String(patch.borderRadius).trim())
    sel.style.borderRadius = cssLength(patch.borderRadius, "px");
  if (patch.fontWeight !== undefined && String(patch.fontWeight).trim())
    sel.style.fontWeight = String(patch.fontWeight).trim();
  if (patch.lineHeight !== undefined && String(patch.lineHeight).trim())
    sel.style.lineHeight = String(patch.lineHeight).trim();
  if (patch.letterSpacing !== undefined && String(patch.letterSpacing).trim())
    sel.style.letterSpacing = cssLength(patch.letterSpacing, "px");
  if (patch.opacity !== undefined) {
    const op = Math.max(0, Math.min(1, Number(patch.opacity)));
    if (Number.isFinite(op)) sel.style.opacity = String(op);
  }
  if (patch.zIndex !== undefined) sel.style.zIndex = String(Number(patch.zIndex) || 0);
  if (patch.filter !== undefined && String(patch.filter).trim()) sel.style.filter = String(patch.filter).trim();
  if (patch.src !== undefined && String(patch.src).trim() && isMediaElement(sel)) {
    sel.setAttribute("src", String(patch.src).trim());
  }
  if (patch.backgroundImage !== undefined && String(patch.backgroundImage).trim()) {
    sel.style.backgroundImage = `url("${String(patch.backgroundImage).trim()}")`;
    if (!sel.style.backgroundSize) sel.style.backgroundSize = "cover";
    if (!sel.style.backgroundPosition) sel.style.backgroundPosition = "center";
    sel.style.backgroundRepeat = "no-repeat";
  }
  if (patch.text !== undefined) {
    if (!isEditableTextElement(sel)) {
      toast("Text change blocked: selected object has no visible text node.");
    } else {
      setEditableText(sel, String(patch.text));
    }
  }
  applyAnimation(sel, patch);
}

// Single-object funnel (Inspector + single-object AI land here): apply to the
// primary, snapshot once, repaint once.
function applyPatch(patch: Patch | null | undefined): void {
  if (!STATE.enabled || !STATE.selected || !patch) return;
  saveState();
  applyPatchToElement(STATE.selected, patch);
  updateOverlay();
  emitMutation();
}

// Multi-object funnel: resolve each op's id to its element and apply, all under a
// single history snapshot and a single repaint/emit.
function applyPatches(ops: PatchOp[] | null | undefined): void {
  if (!STATE.enabled || !Array.isArray(ops) || !ops.length) return;
  saveState();
  let applied = 0;
  for (const op of ops) {
    const el = op && op.id ? (STATE.idLookup.get(op.id) as HTMLElement | undefined) : undefined;
    if (!el || !document.body.contains(el) || !op.patch) continue;
    applyPatchToElement(el, op.patch);
    applied++;
  }
  updateOverlay();
  if (applied) emitMutation();
}

// ---------------------------------------------------------------------------
// Layout verbs — the AI/Toolbar emit a verb + target ids only; the editor reads
// live geometry and computes the pixels, then applies {x,y,w,h} patches through
// applyPatchToElement (so it inherits prepareForMove + the validator clamps).
// No new DOM, no transform writes. No history/emit here — the caller owns those.
// ---------------------------------------------------------------------------

interface ElRect {
  el: HTMLElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

function resolveIds(ids: string[]): HTMLElement[] {
  const els: HTMLElement[] = [];
  for (const id of ids) {
    const el = STATE.idLookup.get(id) as HTMLElement | undefined;
    if (el && document.body.contains(el)) els.push(el);
  }
  return els;
}

function applyLayoutInternal(spec: LayoutOp): boolean {
  const els = resolveIds(spec.ids);
  if (!els.length) return false;
  const rects: ElRect[] = els.map((el) => {
    const r = localRect(el);
    return { el, x: r.x, y: r.y, w: r.w, h: r.h };
  });
  const sr = getSlide(els[0]).getBoundingClientRect();
  const sw = sr.width;
  const sh = sr.height;
  const useSlide = spec.relativeTo === "slide";

  const minX = Math.min(...rects.map((r) => r.x));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));

  const ops: { el: HTMLElement; patch: Patch }[] = [];
  const move = (el: HTMLElement, x: number, y: number) =>
    ops.push({ el, patch: { x: Math.round(x), y: Math.round(y) } });

  switch (spec.op) {
    case "align":
      for (const r of rects) {
        if (spec.axis === "left") move(r.el, useSlide ? 0 : minX, r.y);
        else if (spec.axis === "right") move(r.el, (useSlide ? sw : maxX) - r.w, r.y);
        else if (spec.axis === "hcenter") move(r.el, (useSlide ? sw : minX + maxX) / 2 - r.w / 2, r.y);
        else if (spec.axis === "top") move(r.el, r.x, useSlide ? 0 : minY);
        else if (spec.axis === "bottom") move(r.el, r.x, (useSlide ? sh : maxY) - r.h);
        else if (spec.axis === "vcenter") move(r.el, r.x, (useSlide ? sh : minY + maxY) / 2 - r.h / 2);
      }
      break;
    case "distribute": {
      const horiz = spec.axis === "horizontal";
      const sorted = [...rects].sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const span = horiz ? last.x + last.w - first.x : last.y + last.h - first.y;
      const sumSize = sorted.reduce((s, r) => s + (horiz ? r.w : r.h), 0);
      const gap = (span - sumSize) / (sorted.length - 1);
      let cursor = horiz ? first.x : first.y;
      for (const r of sorted) {
        if (horiz) move(r.el, cursor, r.y);
        else move(r.el, r.x, cursor);
        cursor += (horiz ? r.w : r.h) + gap;
      }
      break;
    }
    case "stack": {
      const gap = spec.gap ?? 12;
      const horiz = spec.axis === "horizontal";
      let cursor = horiz ? minX : minY;
      for (const r of rects) {
        if (horiz) move(r.el, cursor, minY);
        else move(r.el, minX, cursor);
        cursor += (horiz ? r.w : r.h) + gap;
      }
      break;
    }
    case "matchSize": {
      const primary = rects.find((r) => r.el === STATE.selected) ?? rects[0];
      for (const r of rects) {
        const patch: Patch = {};
        if (spec.axis === "width" || spec.axis === "both") patch.w = Math.round(primary.w);
        if (spec.axis === "height" || spec.axis === "both") patch.h = Math.round(primary.h);
        if (Object.keys(patch).length) ops.push({ el: r.el, patch });
      }
      break;
    }
    case "grid": {
      const cols = Math.max(1, spec.cols ?? 2);
      const gap = spec.gap ?? 12;
      const cellW = Math.max(...rects.map((r) => r.w));
      const cellH = Math.max(...rects.map((r) => r.h));
      rects.forEach((r, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        move(r.el, minX + col * (cellW + gap), minY + row * (cellH + gap));
      });
      break;
    }
    case "snapToGrid": {
      const step = Math.max(1, spec.step ?? 20);
      for (const r of rects) move(r.el, Math.round(r.x / step) * step, Math.round(r.y / step) * step);
      break;
    }
  }

  for (const o of ops) applyPatchToElement(o.el, o.patch);
  return ops.length > 0;
}

// ---------------------------------------------------------------------------
// Block insertion — clone a VETTED template, fill its text slots via the
// text-node discipline, position it into a slide. The persisted-style seam
// (mirrors the animation one): <style id="html-ppt-blocks"> is injected into the
// deck once and KEPT by cleanHtml, so exported decks carry the block styling.
// ---------------------------------------------------------------------------

const BLOCK_STYLE_ID = "html-ppt-blocks";
function ensureBlockStyles(): void {
  if (document.getElementById(BLOCK_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = BLOCK_STYLE_ID;
  style.textContent = BLOCK_BASE_CSS;
  document.head.appendChild(style);
}

function insertBlockElement(spec: { blockType: string; slots: { name: string; value: string }[]; target?: { slideIndex?: number; x?: number; y?: number } }): HTMLElement | null {
  const template = BLOCK_TEMPLATES[spec.blockType as BlockType];
  if (!template) return null;
  ensureBlockStyles();

  const tpl = document.createElement("template");
  tpl.innerHTML = template.html.trim();
  const node = tpl.content.firstElementChild as HTMLElement | null;
  if (!node) return null;

  // Fill text slots only (defaults already present in the template markup).
  const slotMap = new Map(spec.slots.map((s) => [s.name, s.value]));
  node.querySelectorAll<HTMLElement>("[data-slot]").forEach((slotEl) => {
    const name = slotEl.getAttribute("data-slot") || "";
    if (slotMap.has(name)) setEditableText(slotEl, String(slotMap.get(name)));
  });

  const slideList = slides();
  const idx =
    spec.target?.slideIndex != null
      ? Math.min(slideList.length, Math.max(1, spec.target.slideIndex)) - 1
      : STATE.currentSlideIndex;
  const slide = slideList[idx] || currentSlide();
  const { w, h } = template.defaultSize;
  node.style.width = px(w);
  slide.appendChild(node);

  const rect = slide.getBoundingClientRect();
  const x = spec.target?.x != null ? spec.target.x : Math.round((rect.width - w) / 2);
  const y = spec.target?.y != null ? spec.target.y : Math.round(rect.height * 0.38);
  node.style.position = "absolute";
  node.style.left = px(x);
  node.style.top = px(y);
  node.setAttribute("data-html-ppt-positioned", "true");
  return node;
}

// ---------------------------------------------------------------------------
// Public API (dispatched to by rpc.ts) — mirrors window.__htmlPptEditorV10
// ---------------------------------------------------------------------------

export const editorApi = {
  setEditMode(enabled: boolean): void {
    const next = !!enabled;
    if (!next) {
      if (STATE.selected && STATE.selected.isContentEditable) finishTextEdit(true);
      document.querySelectorAll('[data-html-ppt-live-edit="true"]').forEach((el) => {
        el.removeAttribute("contenteditable");
        el.removeAttribute("data-html-ppt-live-edit");
      });
      STATE.pointer = null;
      STATE.resize = null;
      STATE.suppressNextClick = false;
      STATE.tool = "select";
      STATE.selection = [];
      STATE.selected = null;
      STATE.selectedId = null;
    }
    STATE.enabled = next;
    document.documentElement.classList.toggle("html-ppt-editor-mode", STATE.enabled);
    document.body.classList.toggle("html-ppt-editor-mode", STATE.enabled);
    updateOverlay();
    emitSelection();
    log("Edit mode: " + STATE.enabled);
  },
  setTool(tool: EditorTool): void {
    if (!STATE.enabled) {
      STATE.tool = "select";
      log("Tool ignored because Edit Mode is OFF");
      return;
    }
    STATE.tool = (["select", "text", "rect"] as const).includes(tool) ? tool : "select";
    log("Tool: " + STATE.tool);
  },
  applyPatch,
  applyPatches,
  // Layout verb (Toolbar or AI). Falls back to the live selection when no ids
  // are supplied (the Toolbar path), so manual align/distribute "just works".
  applyLayout(spec: LayoutOp): void {
    if (!STATE.enabled) return;
    const ids = spec.ids && spec.ids.length ? spec.ids : STATE.selection.map((el) => runtimeId(el));
    saveState();
    const changed = applyLayoutInternal({ ...spec, ids });
    updateOverlay();
    if (changed) emitMutation();
  },
  insertBlock(spec: { blockType: string; slots: { name: string; value: string }[]; target?: { slideIndex?: number; x?: number; y?: number } }): void {
    if (!STATE.enabled) return;
    saveState();
    const node = insertBlockElement(spec);
    if (node) setSelection([node]);
    updateOverlay();
    if (node) emitMutation();
  },
  // The unified envelope entry: a whole AI batch under ONE undo snapshot.
  applyActions(actions: EditorAction[] | null | undefined): void {
    if (!STATE.enabled || !Array.isArray(actions) || !actions.length) return;
    saveState();
    let mutated = false;
    let lastInserted: HTMLElement | null = null;
    for (const a of actions) {
      if (a.type === "patch") {
        const el = STATE.idLookup.get(a.id) as HTMLElement | undefined;
        if (el && document.body.contains(el)) {
          applyPatchToElement(el, a.patch);
          mutated = true;
        }
      } else if (a.type === "layout") {
        if (applyLayoutInternal(a)) mutated = true;
      } else if (a.type === "insertBlock") {
        const node = insertBlockElement(a);
        if (node) {
          lastInserted = node;
          mutated = true;
        }
      }
    }
    if (lastInserted) setSelection([lastInserted]);
    updateOverlay();
    if (mutated) emitMutation();
  },
  deselect(): void {
    deselect();
  },
  selectById(id: string): void {
    selectById(id);
  },
  listBackgroundLayers(): BackgroundLayer[] {
    return listBackgroundLayers();
  },
  copySelected,
  cutSelected,
  paste: pasteClipboard,
  nudgeSelected,
  undo(): void {
    if (STATE.selected && STATE.selected.isContentEditable) finishTextEdit(false);
    if (!historyUndo()) {
      toast("Nothing to undo");
      return;
    }
    setSelection([]);
    scheduleSlideCheck(false);
    toast("Undo");
  },
  redo(): void {
    if (!historyRedo()) {
      toast("Nothing to redo");
      return;
    }
    setSelection([]);
    scheduleSlideCheck(false);
    toast("Redo");
  },
  duplicateSelected(): void {
    if (!STATE.enabled || !STATE.selection.length) return;
    saveState();
    if (STATE.selected && STATE.selected.isContentEditable) finishTextEdit(true);
    const clones: HTMLElement[] = [];
    for (const el of STATE.selection) {
      prepareForMove(el);
      const clone = el.cloneNode(true) as HTMLElement;
      clone.removeAttribute("contenteditable");
      clone.removeAttribute("data-html-ppt-live-edit");
      clone.removeAttribute(AI_ID_ATTR); // the duplicate is a new object → its own thread
      clone.setAttribute("data-html-ppt-positioned", "true");
      if (window.getComputedStyle(clone).position === "static") clone.style.position = "relative";
      clone.style.left = px(cssPxNumber(el.style.left, 0) + 24);
      clone.style.top = px(cssPxNumber(el.style.top, 0) + 24);
      el.parentElement!.insertBefore(clone, el.nextSibling);
      clones.push(clone);
    }
    setSelection(clones);
    emitMutation();
  },
  deleteSelected(): void {
    if (!STATE.enabled || !STATE.selection.length) return;
    saveState();
    if (STATE.selected && STATE.selected.isContentEditable) finishTextEdit(false);
    const doomed = STATE.selection.slice();
    setSelection([]);
    doomed.forEach((el) => el.remove());
    emitMutation();
  },
  bringFront(): void {
    if (!STATE.enabled || !STATE.selection.length) return;
    saveState();
    for (const el of STATE.selection) {
      prepareForMove(el);
      const zi = computedNumber(window.getComputedStyle(el).zIndex, 20);
      el.style.zIndex = String(Math.max(20, zi + 10));
    }
    updateOverlay();
    emitMutation();
  },
  sendBack(): void {
    if (!STATE.enabled || !STATE.selection.length) return;
    saveState();
    for (const el of STATE.selection) {
      prepareForMove(el);
      const zi = computedNumber(window.getComputedStyle(el).zIndex, 20);
      el.style.zIndex = String(Math.max(1, zi - 10));
    }
    updateOverlay();
    emitMutation();
  },
  prevSlide(): void {
    goToSlide(STATE.currentSlideIndex - 1);
  },
  nextSlide(): void {
    goToSlide(STATE.currentSlideIndex + 1);
  },
  goToSlide(n: number): void {
    goToSlide(Number(n) - 1);
  },
  getCleanHtml(): string {
    return cleanHtml();
  },
  getSelectedPayload(): SelectionPayload {
    return payload(STATE.selected);
  },
  getSelectedContext(): SelectedContext | null {
    return selectedContext();
  },
  getSelectionContexts(): SelectedContext[] {
    return getSelectionContexts();
  },
  getSelectedImageData(): string | null {
    return getSelectedImageData();
  },
  assignStableIds(): string[] {
    return assignStableIds();
  },
};

export type EditorApi = typeof editorApi;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function install(): void {
  injectStyle();
  createOverlay();

  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("dblclick", onDoubleClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener(
    "blur",
    (e) => {
      if (STATE.selected && e.target === STATE.selected && (e.target as HTMLElement).isContentEditable) finishTextEdit(true);
    },
    true
  );

  const onViewportChange = () => {
    updateOverlay();
    scheduleSlideCheck(true);
  };
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange, true);
  document.querySelectorAll(".presentation").forEach((el) => el.addEventListener("scroll", onViewportChange, true));

  const h = handle();
  if (h) {
    h.addEventListener("mousedown", (e: MouseEvent) => {
      if (!STATE.enabled || !STATE.selected || e.button !== 0) return;
      saveState(); // one snapshot per resize gesture
      prepareForMove(STATE.selected);
      const r = localRect(STATE.selected);
      STATE.resize = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startW: computedNumber(STATE.selected.style.width, r.w),
        startH: computedNumber(STATE.selected.style.height, r.h),
      };
      e.preventDefault();
      e.stopPropagation();
    });
  }

  observeSlide();
  scheduleSlideCheck(false);
  resetHistory();
  log("HTML PPT editor injected: AI-safe patch + universal text/style editing.");
}
