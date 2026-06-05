// Wizard answer vocabulary — small, fixed menus so each step stays minimal, plus
// the GenerationRequest the client POSTs to /api/generate. "auto" means "let the
// AI decide" everywhere; the prompt is told to choose.
//
// Part of the deck-generation contract (the single source of truth shared by the
// server generator, the dev wiring, and the client wizard). Re-exported from the
// folder barrel (shared/generation/index.ts).

import type { CandidateSeed } from "./types";

export const DECK_PRESETS = [
  "auto",
  "light-editorial",
  "dark-luxury",
  "tech-minimal",
  "dark-glass-2026",
  "vivid",
] as const;
export type DeckPreset = (typeof DECK_PRESETS)[number];

// Human labels + the doc's palette hints, reused by the wizard UI and the prompt.
export const DECK_PRESET_INFO: Record<Exclude<DeckPreset, "auto">, { label: string; hint: string }> = {
  "light-editorial": { label: "Light Editorial", hint: "Warm ivory · gold · serif — 학술·브랜드·F&B" },
  "dark-luxury": { label: "Dark Luxury", hint: "Near-black · gold · Playfair — 프리미엄·뷰티·주류" },
  "tech-minimal": { label: "Tech Minimal", hint: "White · blue · Inter — SaaS·핀테크·B2B" },
  "dark-glass-2026": { label: "Dark Glass 2026", hint: "Glassmorphism · cyan/violet — 스타트업·AI·데이터" },
  vivid: { label: "Vivid", hint: "White · neon brand — 소비자앱·캠페인·MZ" },
};

export const DECK_AUDIENCES = ["auto", "academic", "investor", "executive", "general", "consumer"] as const;
export type DeckAudience = (typeof DECK_AUDIENCES)[number];

export const DECK_LENGTHS = ["auto", "short", "standard", "long"] as const;
export type DeckLength = (typeof DECK_LENGTHS)[number];

export const DECK_LANGUAGES = ["auto", "ko", "en"] as const;
export type DeckLanguage = (typeof DECK_LANGUAGES)[number];

export const DECK_THREE_D = ["auto", "none", "on"] as const;
export type DeckThreeD = (typeof DECK_THREE_D)[number];

// Template FORMAT — how the deck behaves/reads, distinct from its visual preset.
// Drives layout density + interactivity in the generation prompt.
export const DECK_FORMATS = ["auto", "interactive", "presentation", "document"] as const;
export type DeckFormat = (typeof DECK_FORMATS)[number];

export const DECK_FORMAT_INFO: Record<Exclude<DeckFormat, "auto">, { label: string; hint: string }> = {
  interactive: { label: "Interactive", hint: "Clickable · animated reveals · motion-forward" },
  presentation: { label: "Presentation", hint: "Classic full-screen slides for speaking to" },
  document: { label: "Document", hint: "Dense, professional report / whitepaper feel" },
};

// The persona/taste profile — the single biggest driver of the deck's look. Built
// from a quick taste picker, an optional conversational Q&A summary, and a note
// distilled from reference uploads. Persisted as a reusable per-user profile.
export interface PersonaProfile {
  /** Taste-picker selections, keyed by question id (e.g. mood, density, formality). */
  tastePicks?: Record<string, string>;
  /** The conversational interview's distilled summary of the user's style. */
  profileText?: string;
  /** A short note describing the design DNA seen in the user's reference uploads. */
  referenceNote?: string;
}

// One round of the persona interview (the conversational discovery step).
export interface PersonaQA {
  q: string;
  a: string;
}

export interface PersonaInterviewState {
  history: PersonaQA[];
  done: boolean;
  /** The next question to ask, when not done. */
  nextQuestion?: string;
  /** The final inferred profile, when done. */
  profile?: PersonaProfile;
}

// An uploaded reference (image / data / template). Carried as a data URL (images)
// or inlined text (csv/json/md). Kept small + capped by the wizard.
export interface GenerationUpload {
  name: string;
  mime: string;
  kind: "image" | "data" | "reference";
  /** For images: a data: URL. */
  dataUrl?: string;
  /** For text/data files: the decoded text. */
  text?: string;
}

export const MAX_UPLOADS = 6;
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4MB per file

// The full set of wizard answers — what the client POSTs to /api/generate.
export interface GenerationRequest {
  topic: string;
  preset: DeckPreset;
  audience: DeckAudience;
  length: DeckLength;
  language: DeckLanguage;
  threeD: DeckThreeD;
  /** Deck title (the user's explicit headline; falls back to the topic). */
  title?: string;
  /** Template format — interactive / presentation / document (or auto). */
  format?: DeckFormat;
  /** The user's persona/taste profile, the biggest driver of the deck's look. */
  persona?: PersonaProfile;
  /** Locked style of the candidate the user picked, so the full deck matches it. */
  candidateSeed?: CandidateSeed;
  /** Optional "describe in more detail" text captured per step, keyed by step id. */
  detailByStep?: Record<string, string>;
  /** Final free-form prompt on the review step. */
  extraPrompt?: string;
  uploads?: GenerationUpload[];
}
