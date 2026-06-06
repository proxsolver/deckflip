// Browser-side AI client. Never holds the OpenAI key — it calls the serverless
// proxy (/api/ai-edit) and re-runs the validator locally as defense in depth
// before the patches reach applyPatches.

import { validatePatchList, validateActions, sanitizeHtml } from "@shared/editing";
import type { PatchOp } from "@shared/editing";
import type { EditorAction } from "@shared/editing";
import type { SelectedContext } from "@/types/context";
import type { DesignBrief } from "@shared/generation";

export interface AiResult {
  ops: PatchOp[];
  message: string;
  /** true when the patches came from the offline demo engine (no real AI). */
  mock: boolean;
}

// Prompt-export mode (HTML_PPT_AI_MOCK=1): the edit endpoint returns this JSON
// instruction instead of actions, for the user to paste into a Claude Code session.
// Mirrors EditExport in api/_editing/handler.ts.
export interface EditExport {
  object: string;
  user_prompt: string;
  deckId: string;
  contextFiles: string[];
  instruction: string;
}

export interface AiActionResult {
  actions: EditorAction[];
  message: string;
  mock: boolean;
  /** Present in prompt-export mode instead of actions. */
  editExport?: EditExport;
}

// Primary text-edit path: returns the validated action envelope (patch | layout
// | insertBlock). Re-runs the validator client-side (defense in depth) against
// the live selected ids before anything reaches applyActions.
export async function requestAiActions(
  prompt: string,
  contexts: SelectedContext[],
  deckBrief?: DesignBrief,
  deckId?: string
): Promise<AiActionResult> {
  const ids = contexts.map((c) => c.id).filter((id): id is string => !!id);
  const resp = await fetch("/api/ai-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, contexts, deckBrief, deckId }),
  });

  const data = (await resp.json().catch(() => ({}))) as {
    actions?: unknown;
    message?: string;
    error?: string;
    mock?: boolean;
    editExport?: EditExport;
  };
  if (!resp.ok || data.error) {
    throw new Error(data.error || `AI request failed (${resp.status}).`);
  }

  // Prompt-export mode: no actions to apply — surface the Claude Code instruction.
  if (data.editExport) {
    return { actions: [], message: data.message || "Prompt-export mode.", mock: !!data.mock, editExport: data.editExport };
  }

  const actions = validateActions({ actions: data.actions }, ids);
  if (actions.length === 0) {
    throw new Error("AI returned no valid changes after validation.");
  }
  return { actions, message: data.message || "AI changes applied.", mock: !!data.mock };
}

export interface ElementRegenResult {
  /** New, sanitized inner HTML for the selected element. */
  html: string;
  message: string;
  mock: boolean;
}

// Scoped element regeneration: ask the AI to REBUILD the selected element's inner
// HTML from scratch (advanced restyle/restructure). The server sanitizes; we
// sanitize AGAIN here (defense in depth) before it reaches the editor, which runs
// a third DOM-allowlist pass. One element, one undo snapshot.
export async function requestElementRegen(
  prompt: string,
  context: SelectedContext,
  deckBrief?: DesignBrief
): Promise<ElementRegenResult> {
  const resp = await fetch("/api/ai-edit-element", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      context: {
        id: context.id,
        outerHTML: context.outerHTML,
        innerText: context.innerText,
        slideClass: context.slideClass,
        inlineStyle: context.inlineStyle,
      },
      deckBrief,
    }),
  });
  const data = (await resp.json().catch(() => ({}))) as { html?: string; message?: string; error?: string; mock?: boolean };
  if (!resp.ok || data.error) throw new Error(data.error || `Rebuild failed (${resp.status}).`);
  const html = sanitizeHtml(String(data.html || ""));
  if (!html.trim()) throw new Error("Rebuild returned no usable content.");
  return { html, message: data.message || "Rebuilt the element.", mock: !!data.mock };
}

// Web image SEARCH: finds REAL photos on the web for EVERY selected object and
// returns one patch per object (src for <img>, background-image otherwise),
// inlined server-side as data URLs. Re-validated client-side. This is the default
// for "paste pictures" intents — distinct from requestAiImage (which generates).
export async function requestAiImages(
  prompt: string,
  contexts: SelectedContext[],
  deckBrief?: DesignBrief
): Promise<AiResult> {
  const ids = contexts.map((c) => c.id).filter((id): id is string => !!id);
  const resp = await fetch("/api/ai-image-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      contexts: contexts.map((c) => ({ id: c.id, tag: c.tag, text: c.text })),
      deckBrief,
    }),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    patches?: unknown;
    message?: string;
    error?: string;
    mock?: boolean;
  };
  if (!resp.ok || data.error) {
    throw new Error(data.error || `Image search failed (${resp.status}).`);
  }
  const ops = validatePatchList({ patches: data.patches }, ids);
  if (ops.length === 0) {
    throw new Error("No usable web images were found for the selected objects.");
  }
  return { ops, message: data.message || "Pasted web images.", mock: !!data.mock };
}

// Image generation: returns a patch that swaps src (img) or sets background-image
// (any other box) to a generated/placeholder image, re-validated client-side.
export async function requestAiImage(
  prompt: string,
  context: SelectedContext,
  imageBase64?: string | null
): Promise<AiResult> {
  const resp = await fetch("/api/ai-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      context: { id: context.id, tag: context.tag },
      image: imageBase64 || undefined,
    }),
  });

  const data = (await resp.json().catch(() => ({}))) as {
    patches?: unknown;
    message?: string;
    error?: string;
    mock?: boolean;
  };
  if (!resp.ok || data.error) {
    throw new Error(data.error || `Image request failed (${resp.status}).`);
  }

  const ids = context.id ? [context.id] : [];
  const ops = validatePatchList({ patches: data.patches }, ids);
  if (ops.length === 0) {
    throw new Error("Image generation returned nothing usable.");
  }
  return { ops, message: data.message || "Image generated.", mock: !!data.mock };
}
