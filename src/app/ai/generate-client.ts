// Browser-side client for deck generation. Never holds the Anthropic key — it
// POSTs the wizard answers to the serverless generator (/api/generate) and
// returns the validated GeneratedDeck for the app to auto-load.

import {
  coerceDeckFiles,
  type GenerationRequest,
  type GeneratedDeck,
  type DesignBrief,
  type DeckAsset,
  type RegenerateSceneRequest,
  type RegenerateSceneResponse,
  type GenerateCandidatesRequest,
  type GenerateCandidatesResponse,
  type PersonaInterviewRequest,
  type PersonaInterviewResponse,
  type ParseUploadRequest,
  type ParseUploadResponse,
} from "@shared/generation";

// Placeholder brief for prompt-export mode (the real one lands in _brief.json when
// Claude Code writes the deck; loadGeneratedDeck reads it back).
const EMPTY_BRIEF: DesignBrief = {
  topic: "",
  presetUsed: "",
  paletteHex: [],
  fonts: [],
  sections: [],
  threeDMotif: "",
  language: "",
  toneNotes: "",
};

export async function requestGeneration(req: GenerationRequest): Promise<GeneratedDeck> {
  const resp = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  const data = (await resp.json().catch(() => ({}))) as Partial<GeneratedDeck> & { error?: string };
  if (!resp.ok || data.error) {
    throw new Error(data.error || `Generation failed (${resp.status}).`);
  }

  // Prompt-export mode (HTML_PPT_AI_MOCK=1): the server didn't generate a deck — it
  // returned the prompt to run in Claude Code. No files/brief to validate; the wizard
  // shows the prompt panel and loads the deck later via loadGeneratedDeck().
  if (data.promptExport?.deckId) {
    return {
      deckId: data.promptExport.deckId,
      files: { indexHtml: "", styleCss: "", scriptJs: "" },
      brief: data.brief ?? EMPTY_BRIEF,
      message: data.message || "Prompt-export mode.",
      mock: true,
      promptExport: data.promptExport,
    };
  }

  const files = coerceDeckFiles(data.files);
  if (!files || !data.deckId || !data.brief) {
    throw new Error("Generator returned an incomplete deck.");
  }
  // coerceDeckFiles drops the binary assets array — re-attach it from the raw payload.
  const rawAssets = (data.files as { assets?: DeckAsset[] } | undefined)?.assets;
  if (Array.isArray(rawAssets) && rawAssets.length) files.assets = rawAssets;
  return {
    deckId: data.deckId,
    files,
    brief: data.brief,
    message: data.message || "Deck generated.",
    mock: !!data.mock,
    usage: data.usage,
  };
}

// Load a deck that a Claude Code session wrote (or modified) on disk under
// generated/<deckId>/. Powers the prompt-export "Load it" / "Reload deck" buttons.
export async function loadGeneratedDeck(deckId: string): Promise<GeneratedDeck> {
  const resp = await fetch("/api/load-generated", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deckId }),
  });
  const data = (await resp.json().catch(() => ({}))) as Partial<GeneratedDeck> & { error?: string };
  if (!resp.ok || data.error) throw new Error(data.error || `Load failed (${resp.status}).`);
  const files = coerceDeckFiles(data.files);
  if (!files || !data.deckId || !data.brief) {
    throw new Error("The deck folder is missing files — has Claude Code finished writing it?");
  }
  const rawAssets = (data.files as { assets?: DeckAsset[] } | undefined)?.assets;
  if (Array.isArray(rawAssets) && rawAssets.length) files.assets = rawAssets;
  return {
    deckId: data.deckId,
    files,
    brief: data.brief,
    message: data.message || "Loaded the deck.",
    mock: true,
  };
}

// Generate N single-slide style candidates for the user to pick between.
export async function requestCandidates(req: GenerateCandidatesRequest): Promise<GenerateCandidatesResponse> {
  const resp = await fetch("/api/generate-candidates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = (await resp.json().catch(() => ({}))) as Partial<GenerateCandidatesResponse> & { error?: string };
  if (!resp.ok || data.error) throw new Error(data.error || `Candidate generation failed (${resp.status}).`);
  if (!Array.isArray(data.candidates) || !data.candidates.length) throw new Error("No candidates were returned.");
  return { candidates: data.candidates, mock: !!data.mock, usage: data.usage };
}

// One step of the conversational persona interview (next question or final profile).
export async function personaInterview(req: PersonaInterviewRequest): Promise<PersonaInterviewResponse> {
  const resp = await fetch("/api/persona-interview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = (await resp.json().catch(() => ({}))) as Partial<PersonaInterviewResponse> & { error?: string };
  if (!resp.ok || data.error) throw new Error(data.error || `Persona step failed (${resp.status}).`);
  return {
    history: Array.isArray(data.history) ? data.history : req.history,
    done: !!data.done,
    nextQuestion: data.nextQuestion,
    profile: data.profile,
    mock: !!data.mock,
  };
}

// Persist a MODIFICATION prompt (edit / scene-regen / element-regen) to the deck's
// durable server-side history. Best-effort: failures are swallowed so they never
// disrupt the edit itself (the chat UI keeps its own localStorage copy too).
export async function appendDeckPrompt(
  deckId: string,
  entry: { kind: string; prompt: string; summary?: string; usage?: unknown }
): Promise<void> {
  if (!deckId) return;
  try {
    await fetch("/api/deck-prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deckId, op: "append", entry }),
    });
  } catch {
    /* non-fatal */
  }
}

// Server-side parse of one uploaded file → extracted text + embedded images.
export async function parseUpload(req: ParseUploadRequest): Promise<ParseUploadResponse> {
  const resp = await fetch("/api/parse-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = (await resp.json().catch(() => ({}))) as Partial<ParseUploadResponse> & { error?: string };
  if (!resp.ok || data.error) throw new Error(data.error || `File parsing failed (${resp.status}).`);
  return { text: data.text || "", images: Array.isArray(data.images) ? data.images : [], mock: data.mock };
}

// Regenerate the deck's 3D background as a BRAND-NEW three_scene.js (real new
// animation code), vs. the edit-action path which can only tune the 5 vetted
// sceneParam knobs. Returns the new file for the app to hot-swap + reload.
export async function requestSceneRegen(
  prompt: string,
  brief: DesignBrief | undefined,
  currentSceneJs: string | undefined
): Promise<RegenerateSceneResponse> {
  const req: RegenerateSceneRequest = { prompt, brief, currentSceneJs };
  const resp = await fetch("/api/regenerate-scene", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = (await resp.json().catch(() => ({}))) as Partial<RegenerateSceneResponse> & { error?: string };
  if (!resp.ok || data.error) {
    throw new Error(data.error || `Scene regeneration failed (${resp.status}).`);
  }
  if (!data.threeSceneJs) {
    throw new Error("Scene regeneration returned no animation code.");
  }
  return {
    threeSceneJs: data.threeSceneJs,
    threeDMotif: data.threeDMotif || "custom 3D background",
    message: data.message || "Regenerated the 3D background animation.",
    usage: data.usage,
    mock: !!data.mock,
  };
}
