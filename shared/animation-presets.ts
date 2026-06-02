// The ONE definition of the animation preset library — the menu the AI (and the
// Inspector) choose from. Mirrors the patch-keys.ts philosophy: the validator,
// the JSON schema, the editor's applyPatch, and the AI prompt all import from
// here, so the set can never drift. Adding a preset is: add its name + its
// @keyframes block + (optionally) a default below.
//
// SAFETY CONTRACT (load-bearing — see CLAUDE.md "never overwrite transform"):
// every preset's FINAL keyframe is the neutral resting state
// (transform:none; opacity:1). Combined with animation-fill-mode:both this means
// a finished animation leaves the element exactly where the deck's own layout
// expects it — CSS `animation` composes at the computed layer and never writes
// to the element's inline `transform`, so the deck's `.anim`/`.in-view`
// transitions are not clobbered.

export const ANIMATION_NONE = "none";

// The curated 8. Order is the display order in the Inspector dropdown.
export const ANIMATION_PRESETS = [
  "fadeIn",
  "fadeInUp",
  "fadeInDown",
  "slideInLeft",
  "slideInRight",
  "zoomIn",
  "pulse",
  "float",
] as const;

export type AnimationPreset = (typeof ANIMATION_PRESETS)[number];

export const ANIMATION_PRESET_SET: ReadonlySet<string> = new Set(ANIMATION_PRESETS);

// Whitelisted timing functions (enum-only — no raw cubic-bezier(...) so the
// validator stays a strict menu and the CSS injection surface stays closed).
export const ANIMATION_TIMING_FUNCTIONS = [
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "linear",
] as const;

export const ANIMATION_TIMING_SET: ReadonlySet<string> = new Set(ANIMATION_TIMING_FUNCTIONS);

// Keyframe identifiers are namespaced so they can never collide with a deck's
// own @keyframes. The friendly preset name is what the AI/validator/Inspector
// speak; applyPatch maps it to the prefixed keyframe id when writing the style.
export const KEYFRAME_PREFIX = "hpa-";

export function keyframeNameFor(preset: string): string {
  return KEYFRAME_PREFIX + preset;
}

/** Inverse of keyframeNameFor: a prefixed keyframe id back to its friendly name. */
export function presetFromKeyframe(keyframe: string | null | undefined): string {
  if (!keyframe) return ANIMATION_NONE;
  const name = keyframe.startsWith(KEYFRAME_PREFIX) ? keyframe.slice(KEYFRAME_PREFIX.length) : keyframe;
  return ANIMATION_PRESET_SET.has(name) ? name : ANIMATION_NONE;
}

// Sensible per-preset defaults. Used by callers (Inspector picks them when you
// choose a preset; applyPatch backfills duration/iteration when a patch sets a
// name but omits timing) so "just pick fadeInUp" actually animates. Loops
// (pulse/float) default to running forever.
export const ANIMATION_DEFAULTS: Record<AnimationPreset, { duration: string; iterationCount: string }> = {
  fadeIn: { duration: "0.6s", iterationCount: "1" },
  fadeInUp: { duration: "0.6s", iterationCount: "1" },
  fadeInDown: { duration: "0.6s", iterationCount: "1" },
  slideInLeft: { duration: "0.6s", iterationCount: "1" },
  slideInRight: { duration: "0.6s", iterationCount: "1" },
  zoomIn: { duration: "0.5s", iterationCount: "1" },
  pulse: { duration: "1.6s", iterationCount: "infinite" },
  float: { duration: "3s", iterationCount: "infinite" },
};

// The keyframe stylesheet. Injected into the DECK (not the editor UI style) the
// first time an animation is applied, under <style id="html-ppt-animations">,
// which cleanHtml() deliberately KEEPS so exported decks stay self-contained.
// Every block ends at the neutral resting state (see SAFETY CONTRACT above).
export const ANIMATION_CSS = `
@keyframes ${KEYFRAME_PREFIX}fadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes ${KEYFRAME_PREFIX}fadeInUp {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: none; }
}
@keyframes ${KEYFRAME_PREFIX}fadeInDown {
  from { opacity: 0; transform: translateY(-24px); }
  to   { opacity: 1; transform: none; }
}
@keyframes ${KEYFRAME_PREFIX}slideInLeft {
  from { opacity: 0; transform: translateX(-40px); }
  to   { opacity: 1; transform: none; }
}
@keyframes ${KEYFRAME_PREFIX}slideInRight {
  from { opacity: 0; transform: translateX(40px); }
  to   { opacity: 1; transform: none; }
}
@keyframes ${KEYFRAME_PREFIX}zoomIn {
  from { opacity: 0; transform: scale(0.85); }
  to   { opacity: 1; transform: none; }
}
@keyframes ${KEYFRAME_PREFIX}pulse {
  0%, 100% { transform: none; }
  50%      { transform: scale(1.06); }
}
@keyframes ${KEYFRAME_PREFIX}float {
  0%, 100% { transform: none; }
  50%      { transform: translateY(-8px); }
}
`.trim();
