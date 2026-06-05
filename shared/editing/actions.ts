// The action envelope — the unified vocabulary the AI returns and the editor
// applies. Generalizes the original { patches: PatchOp[] } shape so layout
// verbs, block insertion, and (future) slide generation all flow through one
// validated path. Each action is sanitized before it reaches the DOM exactly
// like a patch; the editor's applyActions() runs a batch under a single undo
// snapshot.

import type { Patch } from "./patch-keys";
import type { BlockType } from "./blocks";
import type { SceneParamKey } from "./scene-params";

// --- Layout verbs ---------------------------------------------------------

export const LAYOUT_VERBS = ["align", "distribute", "stack", "matchSize", "grid", "snapToGrid"] as const;
export type LayoutVerb = (typeof LAYOUT_VERBS)[number];
export const LAYOUT_VERB_SET: ReadonlySet<string> = new Set(LAYOUT_VERBS);

export const LAYOUT_AXES = [
  "left",
  "right",
  "hcenter",
  "top",
  "bottom",
  "vcenter",
  "horizontal",
  "vertical",
  "width",
  "height",
  "both",
] as const;
export type LayoutAxis = (typeof LAYOUT_AXES)[number];

// Which axes are meaningful per verb (the validator requires one of these for
// verbs that need an axis; grid/snapToGrid ignore axis).
export const VERB_AXES: Record<LayoutVerb, readonly LayoutAxis[]> = {
  align: ["left", "right", "hcenter", "top", "bottom", "vcenter"],
  distribute: ["horizontal", "vertical"],
  stack: ["horizontal", "vertical"],
  matchSize: ["width", "height", "both"],
  grid: [],
  snapToGrid: [],
};

// Minimum number of target elements a verb needs to do anything sensible.
export const VERB_MIN_COUNT: Record<LayoutVerb, number> = {
  align: 1,
  distribute: 3,
  stack: 2,
  matchSize: 2,
  grid: 1,
  snapToGrid: 1,
};

export interface LayoutOp {
  op: LayoutVerb;
  axis?: LayoutAxis;
  ids: string[];
  relativeTo?: "group" | "slide";
  gap?: number;
  cols?: number;
  step?: number;
}

// --- Block insertion ------------------------------------------------------

export interface BlockSlotValue {
  name: string;
  value: string;
}

export interface BlockTarget {
  slideIndex?: number;
  x?: number;
  y?: number;
}

export interface BlockSpec {
  blockType: BlockType;
  slots: BlockSlotValue[];
  target?: BlockTarget;
}

// --- Scene parameters -----------------------------------------------------

// A single tweak to the deck's 3D / canvas background animation. `key` is one of
// the vetted SCENE_PARAM_KEYS; `value` is a clamped number or a CSS-safe color.
// Unlike patch/layout it targets no DOM id — the deck's scene controller is the
// (single, global) target. The editor never computes or emits anything beyond
// this {key, value} pair.
export interface SceneParamOp {
  key: SceneParamKey;
  value: number | string;
}

// --- The envelope ---------------------------------------------------------

export type EditorAction =
  | ({ type: "patch"; id: string; patch: Patch })
  | ({ type: "layout" } & LayoutOp)
  | ({ type: "insertBlock" } & BlockSpec)
  | ({ type: "sceneParam" } & SceneParamOp);

export interface ActionEnvelope {
  message: string;
  actions: EditorAction[];
}
