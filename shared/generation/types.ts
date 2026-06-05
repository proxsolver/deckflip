// Deck-generation data types — the shapes flowing between the server generator,
// the dev wiring, and the client. Schemas + coercion live in ./schemas; the
// wizard answer vocabulary in ./wizard; token/cost accounting in ./pricing.
//
// Generating a NEW deck is different from EDITING one. Edits flow through
// validateActions() because the AI is mutating a deck the user already trusts;
// the "never emit HTML" invariant guards that path. Generation legitimately
// emits full HTML/CSS/JS, and it is rendered in the same sandboxed srcdoc
// iframe as any user-opened deck — so it does NOT widen the editor's trust
// boundary and does NOT go through the patch validator. The artifact is the
// 4-file deck; the DesignBrief is the compact memory threaded back into later
// AI edits so the editing model knows the deck's original intent.

import type { GenUsage } from "./pricing";

// A binary asset that travels with the deck (an image extracted from an uploaded
// file, or a directly-uploaded image the AI placed into a slide). Carried as a
// data: URL; written to <deckDir>/assets/<path> by storage and registered as a
// blob URL by the client loader so the iframe resolves `assets/...` refs.
export interface DeckAsset {
  /** Deck-relative path, e.g. "assets/img-1.png". */
  path: string;
  /** data: URL holding the bytes. */
  dataUrl: string;
  /** Optional caption/description the AI may use to decide placement. */
  caption?: string;
}

// The generated files. three_scene.js is present only when the deck uses 3D;
// assets carry any images the deck references.
export interface DeckFiles {
  indexHtml: string;
  styleCss: string;
  scriptJs: string;
  threeSceneJs?: string;
  assets?: DeckAsset[];
}

// One image made available to the generation passes (from uploads / parsed files).
// The model sees the path + caption and may place <img src="<path>"> in a slide.
export interface ImageManifestEntry {
  path: string;
  caption: string;
}

// Compact record of the AI's design decisions — persisted with the deck and
// threaded into later edit requests so the editing model remembers intent.
export interface DesignBrief {
  topic: string;
  presetUsed: string;
  paletteHex: string[];
  fonts: string[];
  sections: string[];
  threeDMotif: string;
  language: string;
  toneNotes: string;
}

// What the server returns to the client.
export interface GeneratedDeck {
  deckId: string;
  files: DeckFiles;
  brief: DesignBrief;
  message: string;
  /** true when produced by the offline mock generator (no ANTHROPIC_API_KEY). */
  mock: boolean;
  /** Token usage + estimated cost across all generation passes (absent on mock/old). */
  usage?: GenUsage;
}

// ---------------------------------------------------------------------------
// Candidate previews — 3 one-slide samples the user picks between BEFORE the
// full deck is generated. The chosen candidate's style (brief + style.css)
// becomes a CandidateSeed threaded into full generation so the deck matches the
// previewed look. This is the generation path (it emits HTML) — same trust model
// as a full deck, rendered in the sandboxed srcdoc iframe.
// ---------------------------------------------------------------------------

export interface CandidateResult {
  candidateId: string;
  /** Short human label for the variant, e.g. "Warm editorial". */
  label: string;
  /** A complete, self-contained single-slide HTML document (inlines its CSS). */
  html: string;
  /** The candidate's style.css (the seed for full generation). */
  css: string;
  /** The candidate's compact brief (palette/fonts/tone). */
  brief: DesignBrief;
}

// The locked style of the picked candidate, threaded into the full generation.
export interface CandidateSeed {
  brief: DesignBrief;
  styleCss: string;
}

export interface GenerateCandidatesRequest {
  topic: string;
  title?: string;
  preset: string;
  format?: string;
  audience?: string;
  language?: string;
  persona?: import("./wizard").PersonaProfile;
  /** How many variants to produce (default 3). */
  count?: number;
}

export interface GenerateCandidatesResponse {
  candidates: CandidateResult[];
  mock: boolean;
  usage?: GenUsage;
}

// ---------------------------------------------------------------------------
// Persona interview — the conversational style-discovery step. Stateless on the
// server: the client passes the running history + taste picks; the server returns
// the next question or a final PersonaProfile.
// ---------------------------------------------------------------------------

export interface PersonaInterviewRequest {
  history: Array<{ q: string; a: string }>;
  tastePicks?: Record<string, string>;
  /** Text distilled from reference uploads, if any. */
  referenceText?: string;
  topic?: string;
}

export type PersonaInterviewResponse = import("./wizard").PersonaInterviewState & {
  mock: boolean;
};

// ---------------------------------------------------------------------------
// File parsing — pdf/docx/txt/image → text + extracted images, server-side.
// ---------------------------------------------------------------------------

export interface ParseUploadRequest {
  name: string;
  mime: string;
  /** The file bytes as a data: URL (images, pdf, docx) or plain text via data:text/...;base64. */
  dataUrl: string;
}

export interface ParseUploadResponse {
  /** Extracted text (capped). Empty for pure images. */
  text: string;
  /** Images found inside the document (or the image itself), as data: URLs. */
  images: string[];
  mock?: boolean;
}

// ---------------------------------------------------------------------------
// Multi-pass generation contract (Plan -> Foundation -> Slides -> assemble).
//
// The single emit_deck call is kept as a robustness fallback. The richer
// editorial pipeline (docs/initial_generation_pipeline.md) instead runs three
// LLM passes whose outputs the server stitches into the same DeckFiles shape:
//   1) emit_plan       — design brief + slide-by-slide outline (SCQ narrative)
//   2) emit_foundation — style.css + script.js + three_scene.js + a component
//                        manifest documenting the exact classes slides may use
//   3) emit_slides     — per-section slide HTML + chart-init JS snippets
// Assembly (api/_generation/generate.ts) builds index.html deterministically and
// stitches the chart snippets onto script.js, guaranteeing the editor contract.
// ---------------------------------------------------------------------------

// A single chart spec inside a slide plan (data only; Chart.js config is authored
// in pass 3 as a JS snippet so formatter/callback functions survive).
export interface SlideChartPlan {
  canvasId: string;
  type: string; // "bar" | "line" | "doughnut" | "radar" | ...
  labels: string[];
  series: Array<{ label: string; data: number[] }>;
  note?: string;
  source?: string;
}

// One stat in a stat-strip / KPI component.
export interface SlideStatPlan {
  value: string;
  unit?: string;
  label: string;
  note?: string;
}

// The plan for one slide — enough that pass 3 mostly renders it into the chosen
// editorial component, not invents content.
export interface SlidePlan {
  index: number;
  kind: string; // component kind, e.g. cover, contents, divider, content-2col, stat-strip, kpi, scq, flow, bar-chart, doughnut-chart, quote, callout, node-cards, mega-number, transition, refs, close
  sectionNo?: string; // "01", "01—1", ...
  eyebrowKo?: string; // slide-header Korean chapter label
  eyebrowEn?: string; // slide-header English italic eyebrow
  title?: string;
  subtitle?: string;
  bullets?: string[];
  stats?: SlideStatPlan[];
  chart?: SlideChartPlan;
  quote?: { text: string; cite?: string };
  source?: string;
  notes?: string;
}

export interface DeckPlan {
  brief: DesignBrief;
  slides: SlidePlan[];
}

// One documented component the foundation CSS defines — pass 3 copies these.
export interface ComponentManifestEntry {
  className: string;
  usage: string;
  exampleHtml: string;
}

export interface FoundationResult {
  styleCss: string;
  scriptJs: string;
  threeSceneJs?: string;
  componentManifest: ComponentManifestEntry[];
}

// One rendered slide from pass 3. chartInitJs registers into window.__chartInit.
export interface SlideHtml {
  index: number;
  html: string;
  chartInitJs?: string;
}

// ---------------------------------------------------------------------------
// 3D scene REGENERATION — author a brand-new three_scene.js for a deck the user
// is editing. This is GENERATION, not an edit-patch: it legitimately emits code
// (the deck's own 3D background JS), exactly like initial generation, and runs
// in the same sandboxed srcdoc iframe. It is NOT routed through validateActions
// (the edit-trust gate) — that gate is only for mutating an existing deck via
// the fixed patch/action vocabulary, which can never author motion. This is how
// "make it a totally different 3D animation" actually replaces the animation
// instead of only tuning the 5 vetted sceneParam knobs.
// ---------------------------------------------------------------------------

export interface RegenerateSceneRequest {
  /** The user's instruction, e.g. "make it a totally different animation — flowing ribbons". */
  prompt: string;
  /** The deck's design brief (palette/fonts/3D motif) so the new scene stays on-brand. */
  brief?: DesignBrief;
  /** The deck's CURRENT three_scene.js, so the model keeps the canvas/controller contract. */
  currentSceneJs?: string;
}

export interface RegenerateSceneResponse {
  /** The complete new three_scene.js (exposes window.__htmlPptScene). */
  threeSceneJs: string;
  /** A short label for the new motif (updates the brief's threeDMotif). */
  threeDMotif: string;
  message: string;
  usage?: GenUsage;
  /** true when produced by the offline mock (no API key). */
  mock: boolean;
}
