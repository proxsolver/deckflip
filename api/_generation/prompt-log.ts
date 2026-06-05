// Durable per-deck prompt history endpoint logic. The generator already writes
// generation prompts into _prompts.json (api/_generation/storage.ts); this lets
// the CLIENT persist MODIFICATION prompts (edits, scene/element regen) to the same
// file after the fact, and read the full history back. Node-only (uses the
// local-dir storage seam). Best-effort: a write failure never throws to the user.

import { appendPrompt, readPrompts, type PromptEntry } from "./storage";

export interface DeckPromptsRequest {
  deckId: string;
  /** "append" (default) writes `entry`; "list" returns the full history. */
  op?: "append" | "list";
  entry?: { kind: string; prompt: string; summary?: string; usage?: unknown };
}

export interface DeckPromptsResponse {
  ok: boolean;
  prompts?: PromptEntry[];
}

export async function handleDeckPrompts(req: DeckPromptsRequest): Promise<DeckPromptsResponse> {
  const deckId = (req?.deckId ?? "").trim();
  if (!deckId) throw new Error("deckId is required.");

  if (req.op === "list") {
    return { ok: true, prompts: await readPrompts(deckId) };
  }

  const entry = req.entry;
  if (!entry || typeof entry.prompt !== "string" || !entry.prompt.trim()) {
    throw new Error("A prompt entry with text is required.");
  }
  try {
    await appendPrompt(deckId, {
      ts: new Date().toISOString(),
      kind: String(entry.kind || "edit"),
      prompt: entry.prompt.slice(0, 8000),
      summary: typeof entry.summary === "string" ? entry.summary.slice(0, 500) : undefined,
      usage: entry.usage,
    });
  } catch (err) {
    console.error("[deck-prompts] append failed:", String((err as Error)?.message ?? err));
    return { ok: false };
  }
  return { ok: true };
}
