// Local-directory "backend" store for generated decks (Node-only). This is the
// stand-in until a real backend exists: generated files are written under
// generated/<deckId>/ on the dev host, mirroring what the eventual product
// keeps server-side. Swap THIS module for cloud storage later — nothing else
// needs to change. Generation never fails just because a write failed; the
// caller logs the error and still returns the in-memory contents to the client.

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { DeckFiles, DesignBrief, DeckAsset } from "../../shared/generation";

export interface DeckMeta {
  brief: DesignBrief;
  request: unknown;
  log: unknown;
  /** The multi-pass outline, when generation used it (debug trail → _plan.json). */
  plan?: unknown;
  /** Every prompt sent during generation (durable trail → _prompts.json). */
  prompts?: PromptEntry[];
}

// One persisted prompt for a deck — generation passes AND later modifications.
export interface PromptEntry {
  /** ISO timestamp. */
  ts: string;
  /** generation-plan | generation-foundation | generation-slides | generation-qa |
   *  generation-single | candidate | persona | edit | element-regen | scene-regen */
  kind: string;
  prompt: string;
  /** Optional one-line note (the AI's message, issues found, etc.). */
  summary?: string;
  /** Optional usage snapshot. */
  usage?: unknown;
}

function deckDir(deckId: string): string {
  // process.cwd() is the project root under `npm run dev` / serverless functions.
  return resolve(process.cwd(), "generated", safeId(deckId));
}

// Decode a data: URL into raw bytes for writing to disk (null on malformed).
function decodeDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!m) return null;
  try {
    return m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf-8");
  } catch {
    return null;
  }
}

// deckId is server-generated, but guard against path traversal regardless.
function safeId(deckId: string): string {
  const cleaned = String(deckId).replace(/[^a-zA-Z0-9._-]/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("Invalid deckId.");
  return cleaned;
}

export async function saveDeck(deckId: string, files: DeckFiles, meta: DeckMeta): Promise<string> {
  const dir = deckDir(deckId);
  await mkdir(dir, { recursive: true });
  const writes: Array<Promise<void>> = [
    writeFile(resolve(dir, "index.html"), files.indexHtml, "utf-8"),
    writeFile(resolve(dir, "style.css"), files.styleCss, "utf-8"),
    writeFile(resolve(dir, "script.js"), files.scriptJs, "utf-8"),
    writeFile(resolve(dir, "_brief.json"), JSON.stringify(meta.brief, null, 2), "utf-8"),
    writeFile(resolve(dir, "_log.json"), JSON.stringify(meta.log, null, 2), "utf-8"),
    writeFile(resolve(dir, "_request.json"), JSON.stringify(meta.request, null, 2), "utf-8"),
  ];
  if (files.threeSceneJs) {
    writes.push(writeFile(resolve(dir, "three_scene.js"), files.threeSceneJs, "utf-8"));
  }
  if (meta.plan !== undefined) {
    writes.push(writeFile(resolve(dir, "_plan.json"), JSON.stringify(meta.plan, null, 2), "utf-8"));
  }
  if (meta.prompts && meta.prompts.length) {
    writes.push(writeFile(resolve(dir, "_prompts.json"), JSON.stringify(meta.prompts, null, 2), "utf-8"));
  }
  await Promise.all(writes);

  // Image assets (extracted/uploaded) → assets/ as decoded bytes, so an exported
  // deck folder references them by the same `assets/...` path the HTML uses.
  if (files.assets && files.assets.length) {
    await mkdir(resolve(dir, "assets"), { recursive: true });
    await Promise.all(
      files.assets.map(async (a) => {
        const decoded = decodeDataUrl(a.dataUrl);
        if (!decoded) return;
        // a.path is "assets/<name>"; guard the basename against traversal.
        const base = safeId(a.path.replace(/^assets\//, ""));
        await writeFile(resolve(dir, "assets", base), decoded);
      })
    );
  }
  return dir;
}

// Prompt-export mode (HTML_PPT_AI_MOCK=1): the deck isn't generated server-side —
// instead we persist the request + the exact generation prompt + any image assets
// into generated/<deckId>/ so a Claude Code session can pick them up and write the
// deck files itself. Mirrors the relevant parts of saveDeck. Best-effort caller.
export async function saveExportRequest(
  deckId: string,
  request: unknown,
  promptMarkdown: string,
  assets?: DeckAsset[]
): Promise<string> {
  const dir = deckDir(deckId);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(resolve(dir, "_request.json"), JSON.stringify(request, null, 2), "utf-8"),
    writeFile(resolve(dir, "_generate-prompt.md"), promptMarkdown, "utf-8"),
  ]);
  if (assets && assets.length) {
    await mkdir(resolve(dir, "assets"), { recursive: true });
    await Promise.all(
      assets.map(async (a) => {
        const decoded = decodeDataUrl(a.dataUrl);
        if (!decoded) return;
        const base = safeId(a.path.replace(/^assets\//, ""));
        await writeFile(resolve(dir, "assets", base), decoded);
      })
    );
  }
  return dir;
}

// Append one prompt to a deck's durable _prompts.json (read-modify-write). Used
// for MODIFICATION prompts (edits, scene/element regen) made after generation, so
// every prompt for a deck lives server-side, not only in browser localStorage.
// Best-effort: a missing/corrupt file starts a fresh list; failures are swallowed.
export async function appendPrompt(deckId: string, entry: PromptEntry): Promise<void> {
  const dir = deckDir(deckId);
  const file = resolve(dir, "_prompts.json");
  let list: PromptEntry[] = [];
  try {
    list = JSON.parse(await readFile(file, "utf-8")) as PromptEntry[];
    if (!Array.isArray(list)) list = [];
  } catch {
    /* no file yet */
  }
  list.push(entry);
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(list, null, 2), "utf-8");
}

export async function readPrompts(deckId: string): Promise<PromptEntry[]> {
  try {
    const list = JSON.parse(await readFile(resolve(deckDir(deckId), "_prompts.json"), "utf-8"));
    return Array.isArray(list) ? (list as PromptEntry[]) : [];
  } catch {
    return [];
  }
}

// Optional read-back (for a future GET /api/generated/:id reuse-across-reload route).
export async function readDeck(deckId: string): Promise<{ files: DeckFiles; brief: DesignBrief } | null> {
  const dir = deckDir(deckId);
  try {
    const names = new Set(await readdir(dir));
    const read = (n: string) => readFile(resolve(dir, n), "utf-8");
    const files: DeckFiles = {
      indexHtml: await read("index.html"),
      styleCss: await read("style.css"),
      scriptJs: await read("script.js"),
      threeSceneJs: names.has("three_scene.js") ? await read("three_scene.js") : undefined,
    };
    const brief = JSON.parse(await read("_brief.json")) as DesignBrief;
    return { files, brief };
  } catch {
    return null;
  }
}
