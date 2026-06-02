// Browser-side AI client. Never holds the OpenAI key — it calls the serverless
// proxy (/api/ai-edit) and re-runs the validator locally as defense in depth
// before the patches reach applyPatches.

import { validatePatchList, validateActions } from "@shared/validator";
import type { PatchOp } from "@shared/patch-keys";
import type { EditorAction } from "@shared/actions";
import type { SelectedContext } from "@/types/context";

export interface AiResult {
  ops: PatchOp[];
  message: string;
  /** true when the patches came from the offline demo engine (no real AI). */
  mock: boolean;
}

export interface AiActionResult {
  actions: EditorAction[];
  message: string;
  mock: boolean;
}

// Primary text-edit path: returns the validated action envelope (patch | layout
// | insertBlock). Re-runs the validator client-side (defense in depth) against
// the live selected ids before anything reaches applyActions.
export async function requestAiActions(prompt: string, contexts: SelectedContext[]): Promise<AiActionResult> {
  const ids = contexts.map((c) => c.id).filter((id): id is string => !!id);
  const resp = await fetch("/api/ai-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, contexts }),
  });

  const data = (await resp.json().catch(() => ({}))) as {
    actions?: unknown;
    message?: string;
    error?: string;
    mock?: boolean;
  };
  if (!resp.ok || data.error) {
    throw new Error(data.error || `AI request failed (${resp.status}).`);
  }

  const actions = validateActions({ actions: data.actions }, ids);
  if (actions.length === 0) {
    throw new Error("AI returned no valid changes after validation.");
  }
  return { actions, message: data.message || "AI changes applied.", mock: !!data.mock };
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
