// Image-slot contract — the seam that moves photo PLACEMENT out of the model.
//
// Old behavior: the generation model emitted the real <img src="assets/img-N">
// tags itself, choosing both the layout AND which bytes go where. New behavior:
// the model only RESERVES space and records its INTENT — it emits an empty slot
//   <figure data-image-slot data-image-ref="assets/img-2.png"
//           data-image-intent="Tesla Model 3 front, 3/4 view"></figure>
// and the APP fills the real <img> into that slot at load time (fillImageSlots in
// src/app/io/project-io.ts). The model still gets to "judge" what image belongs
// where (via data-image-ref / data-image-intent), but the app owns the actual
// insertion — sizing, object-fit, lazy-load, and graceful fallback when no asset
// matches. This keeps generation deterministic about images and lets us swap the
// matching strategy without re-prompting the model.
//
// These constants are the single source of truth shared by the server prompt
// (api/_generation/generate.ts → imageManifestText) and the client filler.

/** Marks an element as a reserved image slot the app should fill. */
export const IMAGE_SLOT_ATTR = "data-image-slot";
/** The model's chosen asset path for this slot (one of the manifest paths). */
export const IMAGE_REF_ATTR = "data-image-ref";
/** Short description of what image belongs here — used for matching + alt text. */
export const IMAGE_INTENT_ATTR = "data-image-intent";

/** A photo available to fill slots (deck-relative path + optional caption). */
export interface SlotAsset {
  path: string;
  caption?: string;
}

// Normalize a deck-relative path the way the loader does (drop ./ and leading /).
function normPath(p: string): string {
  return (p || "").trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

// Tokenize a string into lowercased word stems for cheap overlap scoring.
function tokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gi, " ")
    .split(" ")
    .filter((t) => t.length > 1);
}

// Overlap score between an intent and an asset's caption/path (token intersection).
function score(intent: string, asset: SlotAsset): number {
  const want = new Set(tokens(intent));
  if (!want.size) return 0;
  const have = tokens(`${asset.caption ?? ""} ${asset.path}`);
  let hits = 0;
  for (const t of have) if (want.has(t)) hits++;
  return hits;
}

/**
 * Decide which asset path fills a slot, honoring the model's explicit choice first.
 *
 * 1. If `ref` names a real asset, use it (the model's judgment wins, even if reused).
 * 2. Else pick the best caption/intent match among still-unused assets.
 * 3. Else fall back to the first unused asset (so reserved space isn't wasted).
 * 4. Else null — no asset available; the app leaves the slot empty.
 */
export function chooseAssetForSlot(
  intent: string,
  ref: string,
  assets: SlotAsset[],
  used: Set<string>
): string | null {
  if (!assets.length) return null;
  const byPath = new Map(assets.map((a) => [normPath(a.path), a]));

  const wanted = normPath(ref);
  if (wanted && byPath.has(wanted)) return byPath.get(wanted)!.path;

  const free = assets.filter((a) => !used.has(normPath(a.path)));
  if (!free.length) return null;

  if (intent.trim()) {
    let best: SlotAsset | null = null;
    let bestScore = 0;
    for (const a of free) {
      const s = score(intent, a);
      if (s > bestScore) {
        bestScore = s;
        best = a;
      }
    }
    if (best) return best.path;
  }

  return free[0].path;
}
