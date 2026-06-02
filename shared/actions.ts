// The action envelope — the unified vocabulary the AI returns and the editor
// applies. Generalizes the original { patches: PatchOp[] } shape so layout
// verbs, block insertion, and (future) slide generation all flow through one
// validated path. Each action is sanitized before it reaches the DOM exactly
// like a patch; the editor's applyActions() runs a batch under a single undo
// snapshot.

import type { Patch } from "./patch-keys";
import type { BlockType } from "./blocks";

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

// --- The envelope ---------------------------------------------------------

export type EditorAction =
  | ({ type: "patch"; id: string; patch: Patch })
  | ({ type: "layout" } & LayoutOp)
  | ({ type: "insertBlock" } & BlockSpec);

export interface ActionEnvelope {
  message: string;
  actions: EditorAction[];
}
