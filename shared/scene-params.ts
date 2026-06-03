// The vetted scene-parameter menu — the single source of truth for the AI,
// validator, JSON schema, editor, and manual UI, mirroring animation-presets.ts
// and blocks.ts. It lets the AI/Inspector tune a deck's *3D / canvas background
// animation* (spin speed, particle density, light colors, brightness) WITHOUT
// ever emitting code: the AI picks a `key` from this fixed list and a `value`,
// and the editor forwards it to a vetted deck-provided setter. The trust model
// is unchanged — anything outside this menu is dropped by the validator.
//
// THE DECK CONTRACT. A deck opts in by exposing a controller on its own window:
//
//   window.__htmlPptScene = {
//     getParams(): Array<{ key, label, type:"number"|"color", value, min?, max?, step? }>,
//     setParam(key: string, value: number | string): boolean,  // true if applied
//   }
//
// The editor only ever calls these two methods (never deck JS), and a deck
// should persist its own state (e.g. into a kept <script id="html-ppt-scene">)
// so exported decks keep the chosen look. Decks without the controller simply
// have no scene params — the picker hides the panel and `sceneParam` actions
// no-op. Keys a given deck doesn't implement are ignored by its setParam.

export const SCENE_PARAM_KEYS = [
  "spinSpeed",
  "particleOpacity",
  "keyLightColor",
  "fillLightColor",
  "brightness",
] as const;

export type SceneParamKey = (typeof SCENE_PARAM_KEYS)[number];

export const SCENE_PARAM_KEY_SET: ReadonlySet<string> = new Set(SCENE_PARAM_KEYS);

export type SceneParamType = "number" | "color";

export interface SceneParamSpec {
  key: SceneParamKey;
  label: string;
  type: SceneParamType;
  /** For `type:"number"`: inclusive clamp range + UI step. */
  min?: number;
  max?: number;
  step?: number;
  /** Default the deck resets to; also seeds the manual control. */
  default: number | string;
}

export const SCENE_PARAMS: Record<SceneParamKey, SceneParamSpec> = {
  spinSpeed: { key: "spinSpeed", label: "Spin speed", type: "number", min: 0, max: 3, step: 0.1, default: 1 },
  particleOpacity: { key: "particleOpacity", label: "Particle density", type: "number", min: 0, max: 1, step: 0.05, default: 1 },
  keyLightColor: { key: "keyLightColor", label: "Key light color", type: "color", default: "#37c6ff" },
  fillLightColor: { key: "fillLightColor", label: "Fill light color", type: "color", default: "#a855f7" },
  brightness: { key: "brightness", label: "Brightness", type: "number", min: 0.3, max: 2, step: 0.05, default: 1 },
};

/** One tunable parameter as reported live by a deck's `getParams()`. */
export interface SceneParamInfo {
  key: string;
  label: string;
  type: SceneParamType;
  value: number | string;
  min?: number;
  max?: number;
  step?: number;
}

// Universal CSS-animation control — needs NO deck contract. The editor scans the
// deck's background/decoration layers for ones running a CSS @keyframes animation
// and offers a global speed multiplier + play/pause by writing inline
// `animation-duration` / `animation-play-state` (kept by getCleanHtml on export).
// This covers ambient CSS effects on ANY deck, including ones that expose no
// window.__htmlPptScene controller.
export interface BackgroundMotionInfo {
  /** True when at least one CSS-animated background layer exists. */
  available: boolean;
  /** False when any such layer is currently paused. */
  playing: boolean;
  /** Current speed multiplier (1 = the deck's authored timing). */
  speed: number;
}

export interface BackgroundMotionOp {
  speed?: number;
  playing?: boolean;
}
