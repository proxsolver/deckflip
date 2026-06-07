// Deck-generation contract barrel — the single source of truth shared by the
// server generator (api/_generation/*), the dev wiring (vite.config.ts), and the
// client wizard (src/app/components/NewDeckWizard.tsx) + loader.
//
// Split for maintainability:
//   ./wizard   — wizard answer vocabulary + GenerationRequest
//   ./types    — DeckFiles / DesignBrief / GeneratedDeck / multi-pass + scene types
//   ./schemas  — tool-use JSON schemas + coerce* normalizers
//   ./pricing  — token-usage normalization + cost estimation
//
// Importing "@shared/generation" resolves to this barrel, so existing consumers
// keep working unchanged.

export * from "./wizard";
export * from "./types";
export * from "./schemas";
export * from "./pricing";
export * from "./image-slots";
