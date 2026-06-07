// Deck-editing contract barrel — the single source of truth for the patch/action
// vocabulary the editor and AI may apply to an ALREADY-trusted deck. Unlike
// generation (which legitimately emits HTML), every edit flows through
// validateActions() here; the AI never authors markup.
//
// Modules:
//   ./patch-keys        — PATCH_KEYS + Patch / PatchKey / PatchOp types
//   ./actions           — EditorAction envelope + layout verbs
//   ./validator         — validatePatch / validateActions sanitization gate
//   ./patch-schema      — ACTION_ENVELOPE_SCHEMA (structured-output JSON schema)
//   ./animation-presets — curated animation menu (names, keyframes, defaults)
//   ./blocks            — vetted block template library
//   ./scene-params      — 3D / background-motion tuning knobs
//   ./chart             — vetted chart-type menu (Chart.js type switching)
//
// Importing "@shared/editing" resolves to this barrel.

export * from "./patch-keys";
export * from "./actions";
export * from "./validator";
export * from "./patch-schema";
export * from "./animation-presets";
export * from "./blocks";
export * from "./scene-params";
export * from "./chart";
export * from "./sanitize";
