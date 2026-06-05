// Animation application — the preset-library slice of applyPatchToElement. Writes
// inline animation-* longhands referencing the namespaced @keyframes hpa-*,
// restarts via a forced reflow so the preset replays on apply, and clears
// everything on animationName:"none". The keyframe library is injected lazily into
// the DECK as <style id="html-ppt-animations"> (no editor marker → kept by
// getCleanHtml, lives in <head> so undo never drops it). Pure given (sel, patch).

import {
  ANIMATION_NONE,
  ANIMATION_CSS,
  ANIMATION_DEFAULTS,
  ANIMATION_PRESET_SET,
  keyframeNameFor,
  type AnimationPreset,
  type Patch,
} from "@shared/editing";

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

export const ANIMATION_KEYS: (keyof Patch)[] = [
  "animationName",
  "animationDuration",
  "animationDelay",
  "animationTimingFunction",
  "animationIterationCount",
  "animationPlayState",
];

// Apply the animation slice of a patch. `animationName:"none"` clears every
// animation longhand (removes motion). Otherwise we map the friendly preset to
// its namespaced @keyframes, backfill a sensible duration/iteration when the
// patch sets a name but omits them, and force one reflow so the animation
// (re)plays immediately on apply — even when re-selecting the same preset.
export function applyAnimation(sel: HTMLElement, patch: Patch): void {
  const touchesAnimation = ANIMATION_KEYS.some((k) => patch[k] !== undefined);
  if (!touchesAnimation) return;

  if (patch.animationName !== undefined && String(patch.animationName) === ANIMATION_NONE) {
    sel.style.animationName = "";
    sel.style.animationDuration = "";
    sel.style.animationDelay = "";
    sel.style.animationTimingFunction = "";
    sel.style.animationIterationCount = "";
    sel.style.animationFillMode = "";
    sel.style.animationPlayState = "";
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
  // Deck-agnostic: pause/resume whatever animation is already running. Applied
  // last so it sticks regardless of any preset branch above.
  if (patch.animationPlayState !== undefined)
    sel.style.animationPlayState = String(patch.animationPlayState);
}
