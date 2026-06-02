// The ONE definition of editable object properties.
//
// In the old PyQt code this list was duplicated in three places that had to be
// kept in sync by hand (ai/client.py PATCH_KEYS, ai/validator.py
// ALLOWED_PATCH_KEYS, and editor_bridge.js applyPatch). Here every consumer
// imports from this file: the validator, the OpenAI JSON schema, and the
// editor's applyPatch. Adding a property is a one-line change.

export const PATCH_KEYS = [
  "text",
  "x",
  "y",
  "w",
  "h",
  "fontSize",
  "color",
  "backgroundColor",
  "borderColor",
  "borderWidth",
  "borderStyle",
  "borderRadius",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "opacity",
  "zIndex",
  "filter",
  "src",
  "backgroundImage",
  // Animation (Path A — preset library). `animationName` is an enum constrained
  // to the shipped presets in shared/animation-presets.ts; the rest tune timing.
  // The AI only ever picks from this menu — it never authors keyframes/CSS.
  "animationName",
  "animationDuration",
  "animationDelay",
  "animationTimingFunction",
  "animationIterationCount",
] as const;

export type PatchKey = (typeof PATCH_KEYS)[number];

/** A sanitized patch: a subset of the allowed keys with safe values. */
export type Patch = Partial<Record<PatchKey, string | number>>;

/**
 * A patch targeted at one object by its editor runtime id. Multi-object AI edits
 * return a list of these; each element's `patch` is sanitized exactly like the
 * single-object case before it reaches the DOM.
 */
export interface PatchOp {
  id: string;
  patch: Patch;
}
