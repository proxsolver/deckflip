// Port of ai/validator.py — the last trust boundary before an AI-generated
// patch reaches the DOM. The AI is NOT trusted. Unsupported keys are ignored,
// unsafe CSS-like values are dropped (never thrown), so one bad field cannot
// kill an edit. Runs server-side (authoritative) and client-side (defense in
// depth).

import { PATCH_KEYS, type Patch, type PatchKey, type PatchOp } from "./patch-keys";
import { ANIMATION_NONE, ANIMATION_PRESET_SET, ANIMATION_TIMING_SET } from "./animation-presets";
import {
  LAYOUT_VERB_SET,
  VERB_AXES,
  VERB_MIN_COUNT,
  type EditorAction,
  type LayoutOp,
  type LayoutVerb,
  type LayoutAxis,
  type BlockSpec,
  type BlockSlotValue,
  type SceneParamOp,
} from "./actions";
import { SCENE_PARAMS, type SceneParamKey } from "./scene-params";
import { BLOCK_TYPE_SET, BLOCK_TEMPLATES, slotNamesFor, type BlockType } from "./blocks";

const ALLOWED_PATCH_KEYS = new Set<string>(PATCH_KEYS);

const NUMERIC_LIMITS: Record<string, [number, number]> = {
  x: [-20000, 20000],
  y: [-20000, 20000],
  w: [1, 20000],
  h: [1, 20000],
  fontSize: [1, 500],
  opacity: [0, 1],
  zIndex: [-99999, 99999],
};

const LENGTH_RE = /^-?\d{1,5}(\.\d{1,3})?(px|em|rem|%|vh|vw)?$/;
const COLOR_RE = /^[#a-zA-Z0-9(),.%\s-]+$/;
const BORDER_STYLE = new Set(["none", "solid", "dashed", "dotted", "double", "hidden"]);
const FONT_WEIGHT = new Set(["normal", "bold", "lighter", "bolder"]);

// Whitelisted CSS filter functions. The arg of each must be a plain number with
// an optional unit — no nested functions, no url(), no var(). drop-shadow is
// intentionally excluded (it takes colors/lengths that widen the surface).
const FILTER_FN_RE =
  /^(blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia)\(\s*-?\d{1,4}(\.\d{1,3})?(px|deg|rad|turn|%)?\s*\)$/;

function clampNumber(value: unknown, low: number, high: number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(low, min(high, n));
  return Number.isInteger(clamped) ? clamped : Math.round(clamped * 1000) / 1000;
}
function min(a: number, b: number) {
  return a < b ? a : b;
}

function hasCssInjectionChars(text: string): boolean {
  return (
    text.includes(";") ||
    text.includes("{") ||
    text.includes("}") ||
    text.includes("<") ||
    text.includes(">")
  );
}

function safeCssColor(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text.length > 80) return null;
  if (hasCssInjectionChars(text)) return null;
  if (!COLOR_RE.test(text)) return null;
  return text;
}

function safeCssLength(value: unknown, allowUnitless = false): string | number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Math.abs(value) > 20000) return null;
    return Number.isInteger(value) ? value : Math.round(value * 1000) / 1000;
  }
  const text = String(value).trim();
  if (!text || text.length > 40) return null;
  if (hasCssInjectionChars(text)) return null;
  if (allowUnitless) {
    const num = Number(text);
    if (Number.isFinite(num) && num >= 0 && num <= 20) {
      return Math.round(num * 1000) / 1000;
    }
  }
  if (!LENGTH_RE.test(text)) return null;
  return text;
}

function safeFontWeight(value: unknown): string | number | null {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (FONT_WEIGHT.has(text)) return text;
  const num = Number.parseInt(text, 10);
  if (Number.isFinite(num) && num >= 1 && num <= 1000) return num;
  return null;
}

// Generated/replacement images must be self-contained base64 data URLs — never a
// remote/script URL. This keeps the AI from injecting an external or javascript:
// reference, and keeps decks portable (Standalone Export stays self-contained).
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,[a-zA-Z0-9+/]+={0,2}$/;
const MAX_IMAGE_DATA_URL = 10_000_000; // ~10 MB cap

// Animation guards. `animationName` is a strict enum (a shipped preset, or
// "none" to clear). Timing values are bare seconds/ms numbers — no nested
// functions, no var()/url() — and the timing function is enum-only. Anything
// outside the menu is dropped, exactly like an unknown patch key.
function safeAnimationName(value: unknown): string | null {
  const text = String(value).trim();
  if (text.toLowerCase() === ANIMATION_NONE) return ANIMATION_NONE;
  return ANIMATION_PRESET_SET.has(text) ? text : null;
}

const SECONDS_RE = /^\d{1,4}(\.\d{1,3})?(s|ms)?$/;
function safeAnimationTime(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 600) return null;
    return `${Math.round(value * 1000) / 1000}s`;
  }
  const text = String(value).trim();
  if (!text || text.length > 16 || hasCssInjectionChars(text)) return null;
  if (!SECONDS_RE.test(text)) return null;
  // Cap the magnitude so a runaway value can't pin a paint forever.
  const n = Number.parseFloat(text);
  const ms = /ms$/.test(text) ? n : n * 1000;
  if (!Number.isFinite(ms) || ms < 0 || ms > 600000) return null;
  return text.endsWith("s") || text.endsWith("ms") ? text : `${text}s`;
}

function safeAnimationTimingFunction(value: unknown): string | null {
  const text = String(value).trim().toLowerCase();
  return ANIMATION_TIMING_SET.has(text) ? text : null;
}

function safeAnimationIterationCount(value: unknown): string | null {
  const text = String(value).trim().toLowerCase();
  if (text === "infinite") return "infinite";
  const n = Number(text);
  if (!Number.isFinite(n) || n < 1 || n > 1000) return null;
  return String(Math.floor(n));
}

const PLAY_STATE = new Set(["running", "paused"]);
function safeAnimationPlayState(value: unknown): string | null {
  const text = String(value).trim().toLowerCase();
  return PLAY_STATE.has(text) ? text : null;
}

function safeImageDataUrl(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text.length > MAX_IMAGE_DATA_URL) return null;
  return IMAGE_DATA_URL_RE.test(text) ? text : null;
}

// A CSS `filter` value: "none" or one-or-more whitelisted function tokens
// separated only by whitespace (e.g. "blur(6px) brightness(0.7)"). Anything
// outside the whitelist — including url()/var()/nested functions — is dropped.
function safeCssFilter(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text.length > 200) return null;
  if (hasCssInjectionChars(text)) return null;
  if (text.toLowerCase() === "none") return "none";
  const tokens = text.match(/[a-zA-Z-]+\([^()]*\)/g);
  if (!tokens) return null;
  // Reject stray characters between/around the function tokens.
  if (tokens.join("").replace(/\s+/g, "") !== text.replace(/\s+/g, "")) return null;
  for (const t of tokens) {
    if (!FILTER_FN_RE.test(t.trim())) return null;
  }
  return text;
}

/**
 * Validate and sanitize an AI-returned patch. Accepts either a bare patch
 * object or the wrapper shape `{ patch: {...}, message: "..." }`.
 */
export function validatePatch(raw: unknown): Patch {
  if (raw == null) return {};
  const source =
    typeof raw === "object" && raw !== null && "patch" in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).patch
      : raw;
  if (typeof source !== "object" || source === null) return {};

  const patch = source as Record<string, unknown>;
  const clean: Patch = {};

  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (!ALLOWED_PATCH_KEYS.has(key) || value == null) continue;
    const k = key as PatchKey;

    if (k in NUMERIC_LIMITS) {
      const [low, high] = NUMERIC_LIMITS[k];
      const num = clampNumber(value, low, high);
      if (num !== null) clean[k] = num;
      continue;
    }

    if (k === "text") {
      // Cap to keep an API accident from exploding the DOM / freezing the UI.
      clean.text = String(value).slice(0, 8000);
      continue;
    }

    if (k === "color" || k === "backgroundColor" || k === "borderColor") {
      const color = safeCssColor(value);
      if (color) clean[k] = color;
      continue;
    }

    if (k === "borderWidth" || k === "borderRadius" || k === "letterSpacing") {
      const length = safeCssLength(value);
      if (length !== null) clean[k] = length;
      continue;
    }

    if (k === "lineHeight") {
      const lh = safeCssLength(value, true);
      if (lh !== null) clean.lineHeight = lh;
      continue;
    }

    if (k === "borderStyle") {
      const style = String(value).trim().toLowerCase();
      if (BORDER_STYLE.has(style)) clean.borderStyle = style;
      continue;
    }

    if (k === "fontWeight") {
      const weight = safeFontWeight(value);
      if (weight !== null) clean.fontWeight = weight;
      continue;
    }

    if (k === "filter") {
      const filter = safeCssFilter(value);
      if (filter !== null) clean.filter = filter;
      continue;
    }

    if (k === "src" || k === "backgroundImage") {
      const img = safeImageDataUrl(value);
      if (img) clean[k] = img;
      continue;
    }

    if (k === "animationName") {
      const name = safeAnimationName(value);
      if (name !== null) clean.animationName = name;
      continue;
    }

    if (k === "animationDuration" || k === "animationDelay") {
      const t = safeAnimationTime(value);
      if (t !== null) clean[k] = t;
      continue;
    }

    if (k === "animationTimingFunction") {
      const fn = safeAnimationTimingFunction(value);
      if (fn !== null) clean.animationTimingFunction = fn;
      continue;
    }

    if (k === "animationIterationCount") {
      const ic = safeAnimationIterationCount(value);
      if (ic !== null) clean.animationIterationCount = ic;
      continue;
    }

    if (k === "animationPlayState") {
      const ps = safeAnimationPlayState(value);
      if (ps !== null) clean.animationPlayState = ps;
      continue;
    }
  }

  return clean;
}

/**
 * Validate a multi-object AI response: the wrapper shape `{ patches: [{ id, ... }] }`
 * (or a bare array). Each entry is sanitized via validatePatch; entries whose `id`
 * is not in `allowedIds` (the live selected set) are dropped, as are entries that
 * sanitize down to no usable keys. Never throws — bad entries are simply omitted.
 */
export function validatePatchList(raw: unknown, allowedIds: readonly string[]): PatchOp[] {
  const allowed = new Set(allowedIds);
  const source =
    raw && typeof raw === "object" && "patches" in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).patches
      : raw;
  if (!Array.isArray(source)) return [];

  const ops: PatchOp[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== "string" || !allowed.has(id) || seen.has(id)) continue;
    const patch = validatePatch(item);
    if (Object.keys(patch).length === 0) continue;
    seen.add(id);
    ops.push({ id, patch });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Action envelope validators (layout verbs + block insertion). Same contract as
// validatePatch: drop anything outside the menu, never throw. The AI supplies a
// verb/blockType + targets; the editor does all geometry/DOM work.
// ---------------------------------------------------------------------------

function clampInt(value: unknown, low: number, high: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(low, Math.min(high, Math.round(n)));
}

/**
 * Validate a layout op. `ids` is intersected with `allowedIds` (the live
 * selection); the op is dropped unless its verb/axis are in the menu and enough
 * targets remain for that verb. Returns null on any failure.
 */
export function validateLayoutOp(raw: unknown, allowedIds: readonly string[]): LayoutOp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const op = String(r.op ?? "") as LayoutVerb;
  if (!LAYOUT_VERB_SET.has(op)) return null;

  const allowed = new Set(allowedIds);
  const ids = Array.isArray(r.ids)
    ? r.ids.filter((id): id is string => typeof id === "string" && allowed.has(id))
    : [];
  // De-dupe while preserving order (stack/grid honor selection order).
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length < VERB_MIN_COUNT[op]) return null;

  const out: LayoutOp = { op, ids: uniqueIds };

  const axes = VERB_AXES[op];
  if (axes.length) {
    const axis = String(r.axis ?? "").toLowerCase() as LayoutAxis;
    if (!axes.includes(axis)) return null;
    out.axis = axis;
  }

  if (r.relativeTo === "slide" || r.relativeTo === "group") out.relativeTo = r.relativeTo;
  if (r.gap != null) out.gap = clampInt(r.gap, 0, 2000, 12);
  if (op === "grid") out.cols = clampInt(r.cols, 1, 12, 2);
  if (op === "snapToGrid") out.step = clampInt(r.step, 1, 2000, 20);

  return out;
}

/**
 * Validate a block-insertion spec. `blockType` must be a shipped block; only the
 * slot names that block defines are kept, each coerced to capped text; `target`
 * is clamped. Returns null if the block type is unknown.
 */
export function validateBlockSpec(raw: unknown): BlockSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const blockType = String(r.blockType ?? "") as BlockType;
  if (!BLOCK_TYPE_SET.has(blockType)) return null;

  const validNames = slotNamesFor(blockType);
  const byName = new Map<string, BlockSlotValue>();
  const template = BLOCK_TEMPLATES[blockType];
  const rawSlots = Array.isArray(r.slots) ? r.slots : [];
  for (const s of rawSlots) {
    if (!s || typeof s !== "object") continue;
    const name = String((s as Record<string, unknown>).name ?? "");
    if (!validNames.has(name) || byName.has(name)) continue;
    const max = template.slots.find((t) => t.name === name)?.maxLength ?? 400;
    const value = String((s as Record<string, unknown>).value ?? "").slice(0, max);
    byName.set(name, { name, value });
  }

  const spec: BlockSpec = { blockType, slots: [...byName.values()] };

  const t = r.target as Record<string, unknown> | undefined;
  if (t && typeof t === "object") {
    const target: { slideIndex?: number; x?: number; y?: number } = {};
    if (t.slideIndex != null) target.slideIndex = clampInt(t.slideIndex, 1, 9999, 1);
    if (t.x != null) target.x = clampInt(t.x, -20000, 20000, 0);
    if (t.y != null) target.y = clampInt(t.y, -20000, 20000, 0);
    if (Object.keys(target).length) spec.target = target;
  }

  return spec;
}

/**
 * Validate a scene-parameter tweak. `key` must be a vetted SCENE_PARAM_KEY;
 * number values are clamped to the param's range, color values pass the same
 * CSS-color gate as patches. Accepts either the canonical {key,value} shape or
 * the AI's flat {sceneKey,sceneValue} fields. Returns null if the key is unknown
 * or the value can't be made safe. Doesn't depend on selection ids — the deck's
 * scene controller is the (global) target.
 */
export function validateSceneParamOp(raw: unknown): SceneParamOp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = String(r.key ?? r.sceneKey ?? "") as SceneParamKey;
  const spec = SCENE_PARAMS[key];
  if (!spec) return null;
  const rawValue = r.value ?? r.sceneValue;
  if (spec.type === "number") {
    const v = clampNumber(rawValue, spec.min ?? 0, spec.max ?? 1);
    if (v == null) return null;
    return { key, value: v };
  }
  const c = safeCssColor(rawValue);
  if (!c) return null;
  return { key, value: c };
}

/**
 * Validate a full action envelope (`{ actions: [...] }` or a bare array) against
 * the live selected ids. Dispatches per action `type`; invalid actions are
 * dropped. Never throws.
 */
export function validateActions(raw: unknown, allowedIds: readonly string[]): EditorAction[] {
  const allowed = new Set(allowedIds);
  const source =
    raw && typeof raw === "object" && "actions" in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).actions
      : raw;
  if (!Array.isArray(source)) return [];

  const out: EditorAction[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const type = (item as Record<string, unknown>).type;

    if (type === "patch") {
      const id = (item as Record<string, unknown>).id;
      if (typeof id !== "string" || !allowed.has(id)) continue;
      // The patch may be nested under `patch` or inline alongside `id`.
      const patch = validatePatch(item);
      if (Object.keys(patch).length === 0) continue;
      out.push({ type: "patch", id, patch });
    } else if (type === "layout") {
      const op = validateLayoutOp(item, allowedIds);
      if (op) out.push({ type: "layout", ...op });
    } else if (type === "insertBlock") {
      const spec = validateBlockSpec(item);
      if (spec) out.push({ type: "insertBlock", ...spec });
    } else if (type === "sceneParam") {
      const op = validateSceneParamOp(item);
      if (op) out.push({ type: "sceneParam", ...op });
    }
  }
  return out;
}
