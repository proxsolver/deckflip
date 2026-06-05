// Background-animation control — two independent capabilities the editor exposes
// for the part of a deck the patch/style system can't touch (the moving 3D/canvas
// background and CSS-keyframe background layers). Imports only state + dom-utils,
// never core, so core can import these freely.
//
// (1) Scene params: tune a deck's 3D / canvas background via the deck's OWN
//     controller (window.__htmlPptScene). We only ever call its two vetted
//     methods getParams()/setParam(); the deck owns applying + persisting.
// (2) Universal CSS-animation control: needs NO deck cooperation — find the
//     background/decoration layers running a CSS @keyframes animation and write
//     inline animation-duration (scaled from the deck's ORIGINAL timing, remembered
//     per element so changes never compound) + animation-play-state. Inline styles
//     on body-level layers are kept by getCleanHtml, so speed/pause survive export.

import { BACKGROUND_SELECTOR } from "./state";
import { isEditorUi } from "./dom-utils";
import type {
  SceneParamInfo,
  BackgroundMotionInfo,
  BackgroundMotionOp,
  SceneParamOp,
  SceneSectionInfo,
  SceneAssignOp,
} from "@shared/editing";

// --- scene params (deck controller) -----------------------------------------

interface DeckSceneController {
  getParams?: () => SceneParamInfo[];
  setParam?: (key: string, value: number | string) => boolean;
  // Optional per-section scene methods (additive contract).
  listScenes?: () => string[];
  getSectionScenes?: () => Array<{ section: string; sceneName: string }>;
  setSceneForSection?: (section: string, sceneName: string) => boolean;
}

function deckScene(): DeckSceneController | null {
  const s = (window as unknown as { __htmlPptScene?: DeckSceneController }).__htmlPptScene;
  return s && typeof s === "object" ? s : null;
}

// Live list of tunable params, or [] when this deck exposes no scene controller
// (the shell hides the Scene panel in that case).
export function listSceneParams(): SceneParamInfo[] {
  const s = deckScene();
  if (!s || typeof s.getParams !== "function") return [];
  try {
    const list = s.getParams();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function applySceneParamInternal(op: SceneParamOp): boolean {
  const s = deckScene();
  if (!s || typeof s.setParam !== "function") return false;
  try {
    return s.setParam(op.key, op.value) !== false;
  } catch {
    return false;
  }
}

// --- per-section scenes (optional deck contract) ----------------------------

// Live per-section scene state, or { available:false } for decks that don't
// expose the per-section methods (the Scene panel hides its section UI then).
export function listSceneSections(): SceneSectionInfo {
  const s = deckScene();
  if (!s || typeof s.listScenes !== "function" || typeof s.setSceneForSection !== "function") {
    return { available: false, scenes: [], sections: [] };
  }
  try {
    const scenes = Array.isArray(s.listScenes()) ? s.listScenes() : [];
    const sections =
      typeof s.getSectionScenes === "function" && Array.isArray(s.getSectionScenes()) ? s.getSectionScenes() : [];
    return { available: scenes.length > 0, scenes, sections };
  } catch {
    return { available: false, scenes: [], sections: [] };
  }
}

export function applySceneAssignment(op: SceneAssignOp): boolean {
  const s = deckScene();
  if (!s || typeof s.setSceneForSection !== "function") return false;
  try {
    return s.setSceneForSection(op.section, op.sceneName) !== false;
  } catch {
    return false;
  }
}

// --- universal CSS-animation control ----------------------------------------

const BG_MOTION_BASE = new WeakMap<HTMLElement, string>();
let bgMotionSpeed = 1;

function animatedBgLayers(): HTMLElement[] {
  const seen = new Set<Element>();
  const out: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>(BACKGROUND_SELECTOR).forEach((el) => {
    if (seen.has(el) || el.closest(".slide") || isEditorUi(el)) return;
    seen.add(el);
    const cs = window.getComputedStyle(el);
    if (cs.display === "none") return;
    if (!cs.animationName || cs.animationName === "none") return;
    out.push(el);
  });
  return out;
}

function parseSecondsList(s: string): number[] {
  return s.split(",").map((part) => {
    const t = part.trim();
    const n = Number.parseFloat(t);
    if (!Number.isFinite(n)) return 0;
    return /ms$/.test(t) ? n / 1000 : n;
  });
}

export function listBackgroundMotion(): BackgroundMotionInfo {
  const layers = animatedBgLayers();
  if (!layers.length) return { available: false, playing: true, speed: bgMotionSpeed };
  let anyPaused = false;
  for (const el of layers) {
    const ps = window.getComputedStyle(el).animationPlayState || "running";
    if (ps.split(",").some((s) => s.trim() === "paused")) anyPaused = true;
  }
  return { available: true, playing: !anyPaused, speed: bgMotionSpeed };
}

export function applyBackgroundMotion(op: BackgroundMotionOp): boolean {
  const layers = animatedBgLayers();
  if (!layers.length) return false;
  if (typeof op.speed === "number" && Number.isFinite(op.speed)) {
    const mult = Math.max(0.1, Math.min(10, op.speed));
    bgMotionSpeed = mult;
    for (const el of layers) {
      let base = BG_MOTION_BASE.get(el);
      if (base == null) {
        base = window.getComputedStyle(el).animationDuration || "0s";
        BG_MOTION_BASE.set(el, base);
      }
      el.style.animationDuration = parseSecondsList(base)
        .map((sec) => `${Math.round((sec / mult) * 1000) / 1000}s`)
        .join(", ");
    }
  }
  if (typeof op.playing === "boolean") {
    for (const el of layers) el.style.animationPlayState = op.playing ? "running" : "paused";
  }
  return true;
}
