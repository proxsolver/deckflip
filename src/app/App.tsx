// Application shell — the web equivalent of main_window.py. Owns deck loading,
// edit-mode/tool state, the AI flow, and save/export. All deck mutation goes
// through the editor bridge (postMessage), never by touching the iframe DOM.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Patch } from "@shared/editing";
import type { EditorTool } from "@/types/messages";
import type { SelectionPayload, BackgroundLayer, SlideSummary } from "@/types/context";
import type { InsertSlideSpec } from "@/types/messages";
import type { SceneParamInfo, BackgroundMotionInfo, BackgroundMotionOp } from "@shared/editing";
import type { SceneParamOp, SceneSectionInfo, SceneAssignOp } from "@shared/editing";
import { Toolbar } from "./components/Toolbar";
import { Inspector } from "./components/Inspector";
import { DeckFrame } from "./components/DeckFrame";
import { AiChat, type ChatMsg } from "./components/AiChat";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { NewDeckWizard } from "./components/NewDeckWizard";
import { SlidesPanel } from "./components/SlidesPanel";
import { SparkleIcon } from "./components/icons";
import { useEditorBridge } from "./hooks/useEditorBridge";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { requestAiActions, requestAiImages, requestElementRegen, type EditExport } from "./ai/client";
import { requestSceneRegen, requestSlide, appendDeckPrompt, loadGeneratedDeck } from "./ai/generate-client";
import { installGlobalErrorCapture, logger } from "./lib/logger";
import type { DesignBrief, DeckFiles, GeneratedDeck } from "@shared/generation";
import { formatUsage } from "@shared/generation";
import {
  openDeckViaPicker,
  openDeckFromFileList,
  releaseDeck,
  saveHtmlInPlace,
  downloadHtml,
  exportProjectToDirectory,
  exportStandaloneHtml,
  buildDeckFromContents,
  replaceDeckAsset,
  injectThreeScaffold,
  addThreeSceneToDeck,
  DEFAULT_THREE_SCENE_JS,
  downloadDeckFiles,
  type LoadedDeck,
} from "./io/project-io";

const EMPTY_SELECTION: SelectionPayload = {};

// A per-selection key so each object (or multi-object combo) keeps its own chat
// thread. Prefer the durable data-ai-id markers ("aid:") — those survive undo,
// save/export and reopen and are persisted to localStorage. Until an object has
// been chatted about it has no marker, so fall back to the volatile runtime id
// ("rt:"), which is enough to show the (empty) thread for the current session.
function selectionKey(sel: SelectionPayload): string {
  const stable = sel.selectionStableIds;
  if (stable && stable.length && stable.every((s): s is string => !!s)) {
    return "aid:" + [...stable].sort().join(",");
  }
  if (sel.selectionIds && sel.selectionIds.length) return "rt:" + [...sel.selectionIds].sort().join(",");
  return sel.id ? "rt:" + sel.id : "";
}

// Stable signature for a deck, invariant to the markers we add, so a deck's
// persisted threads still match after it's been saved with data-ai-id attributes.
function deckSignature(html: string): string {
  const stripped = html.replace(/\s*data-ai-id="[^"]*"/g, "");
  let h = 2166136261;
  for (let i = 0; i < stripped.length; i++) {
    h ^= stripped.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const THREADS_LS_PREFIX = "slidesmith.chat.";
const BRIEF_LS_PREFIX = "slidesmith.brief.";

function loadPersistedThreads(deckKey: string): Record<string, ChatMsg[]> {
  try {
    const raw = localStorage.getItem(THREADS_LS_PREFIX + deckKey);
    return raw ? (JSON.parse(raw) as Record<string, ChatMsg[]>) : {};
  } catch {
    return {};
  }
}

// The design brief is the "memory" that keeps the generation session alive: it's
// persisted with the deck (keyed by deckSignature, like chat threads) and
// threaded into later AI edits so the editing model remembers the deck's intent.
function loadPersistedBrief(deckKey: string): DesignBrief | null {
  try {
    const raw = localStorage.getItem(BRIEF_LS_PREFIX + deckKey);
    return raw ? (JSON.parse(raw) as DesignBrief) : null;
  } catch {
    return null;
  }
}

function persistBrief(deckKey: string, brief: DesignBrief): void {
  try {
    localStorage.setItem(BRIEF_LS_PREFIX + deckKey, JSON.stringify(brief));
  } catch {
    /* quota/disabled — non-fatal */
  }
}

// "Last working deck" — the client-side stand-in for the future per-user backend.
// We persist the deck's files (index.html kept current with edits; css/js/3D are
// unchanged by the editor, which only writes inline styles on the index DOM) so
// the deck is recalled on next launch instead of an empty canvas. Only set for
// AI-generated decks (we have their text); disk-opened folders clear it (the user
// can reopen those themselves, and their assets are too large for localStorage).
const LAST_DECK_LS_KEY = "slidesmith.lastDeck";

interface LastDeck {
  deckId: string;
  files: DeckFiles;
  brief: DesignBrief | null;
}

function loadLastDeck(): LastDeck | null {
  try {
    const raw = localStorage.getItem(LAST_DECK_LS_KEY);
    const parsed = raw ? (JSON.parse(raw) as LastDeck) : null;
    return parsed && parsed.files && typeof parsed.files.indexHtml === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function persistLastDeck(d: LastDeck): void {
  try {
    localStorage.setItem(LAST_DECK_LS_KEY, JSON.stringify(d));
  } catch {
    /* quota exceeded (e.g. large embedded images) or disabled — non-fatal */
  }
}

function clearLastDeck(): void {
  try {
    localStorage.removeItem(LAST_DECK_LS_KEY);
  } catch {
    /* non-fatal */
  }
}

// The live DOM references css/js/assets by blob: URL. Convert those back to the
// deck's original relative paths so the saved index.html can be re-loaded (and
// re-blobbed) next session. The editor never edits css/js, so pairing this
// edited index.html with the original css/js faithfully restores the deck + edits.
function normalizeBlobRefs(html: string, deck: LoadedDeck | null): string {
  if (!deck) return html;
  let out = html;
  for (const [url, path] of deck.pathForUrl) out = out.split(url).join(path);
  return out;
}

export function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const deckRef = useRef<LoadedDeck | null>(null);

  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(true);
  const [tool, setTool] = useState<EditorTool>("select");
  const [slide, setSlide] = useState({ current: 0, total: 0 });
  const [selection, setSelection] = useState<SelectionPayload>(EMPTY_SELECTION);
  const [status, setStatus] = useState("Open a deck folder to begin.");
  const [aiOpen, setAiOpen] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [helpOpen, setHelpOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Source of the currently loaded AI-generated deck (so the user can download
  // the raw 4 files); null for disk-loaded decks.
  const [hasAiSource, setHasAiSource] = useState(false);
  // Slide-management filmstrip (Phase 3).
  const [slidesOpen, setSlidesOpen] = useState(false);
  const [slidesList, setSlidesList] = useState<SlideSummary[]>([]);
  const [slideBusy, setSlideBusy] = useState(false);
  const aiFilesRef = useRef<DeckFiles | null>(null);
  const lastDeckIdRef = useRef<string>("");
  // Set by "Add 3D background" so the new layer is auto-selected after the reload.
  const pendingSelect3DRef = useRef(false);
  // Debounced autosave of the working deck (set after the bridge exists).
  const scheduleAutosaveRef = useRef<() => void>(() => {});
  const autosaveTimer = useRef<number | null>(null);
  // The current deck's design brief, threaded into AI edits as memory.
  const briefRef = useRef<DesignBrief | null>(null);
  // Per-object chat threads (keyed by selectionKey), kept in the shell so they
  // survive switching objects and closing/reopening the panel.
  const [threads, setThreads] = useState<Record<string, ChatMsg[]>>({});
  const msgSeq = useRef(0);
  const deckKeyRef = useRef("");

  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;

  const appendMessage = useCallback((key: string, msg: Omit<ChatMsg, "id">) => {
    if (!key) return;
    setThreads((t) => ({ ...t, [key]: [...(t[key] ?? []), { ...msg, id: ++msgSeq.current }] }));
  }, []);

  // Persist durable (aid:) threads per deck so they survive a full reload/reopen.
  useEffect(() => {
    const key = deckKeyRef.current;
    if (!key) return;
    try {
      const durable: Record<string, ChatMsg[]> = {};
      for (const [k, v] of Object.entries(threads)) if (k.startsWith("aid:") && v.length) durable[k] = v;
      if (Object.keys(durable).length) localStorage.setItem(THREADS_LS_PREFIX + key, JSON.stringify(durable));
      else localStorage.removeItem(THREADS_LS_PREFIX + key);
    } catch {
      /* localStorage may be full or disabled — non-fatal */
    }
  }, [threads]);

  const bridge = useEditorBridge(iframeRef, {
    onReady: () => {
      // Sync the current toolbar state into the freshly injected editor,
      // mirroring inject_editor_js + setEditMode in the desktop app.
      bridge.setEditMode(editModeRef.current);
      bridge.setTool("select");
      setStatus("Editor ready.");
      // Just added a 3D layer → auto-select it once the scene has initialized.
      if (pendingSelect3DRef.current) {
        pendingSelect3DRef.current = false;
        window.setTimeout(() => void bridge.select3DLayer(), 400);
      }
    },
    onSelection: (payload) => setSelection(payload),
    onMutation: (payload) => {
      setSelection(payload);
      scheduleAutosaveRef.current();
    },
    onSlide: (s) => setSlide(s),
    onHistory: (h) => setHistory(h),
    onLog: (msg) => setStatus(msg),
  });

  useKeyboardShortcuts(bridge, editMode && !!srcDoc, !!selection.id);

  // Debounced autosave: after edits settle, capture the current clean HTML and
  // persist it as the "last working deck" (only for AI decks, which we can
  // represent as text). The ref indirection lets the bridge's onMutation call
  // this even though it's defined after the bridge.
  const scheduleAutosave = useCallback(() => {
    if (!aiFilesRef.current) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(async () => {
      try {
        const html = (await bridge.getCleanHtml()) as string;
        if (!html) return;
        const files: DeckFiles = { ...aiFilesRef.current!, indexHtml: normalizeBlobRefs(html, deckRef.current) };
        aiFilesRef.current = files;
        persistLastDeck({ deckId: lastDeckIdRef.current, files, brief: briefRef.current });
      } catch (err) {
        logger.warn("app", "Autosave failed", String((err as Error)?.message ?? err));
      }
    }, 1500);
  }, [bridge]);
  scheduleAutosaveRef.current = scheduleAutosave;

  // Assign durable markers to the current selection and return its persistent
  // thread key. Called when the user actually sends a message (not on select).
  const resolveThreadKey = useCallback(async (): Promise<string> => {
    const aids = await bridge.assignStableIds();
    if (!aids || !aids.length) return "";
    return "aid:" + [...aids].sort().join(",");
  }, [bridge]);

  const loadDeck = useCallback((deck: LoadedDeck) => {
    releaseDeck(deckRef.current);
    deckRef.current = deck;
    setSelection(EMPTY_SELECTION);
    setSlide({ current: 0, total: 0 });
    // Restore this deck's durable chat threads + design brief (both keyed by
    // the marker-invariant deck signature). Default to non-AI source; onGenerated
    // sets the raw files afterwards.
    deckKeyRef.current = deckSignature(deck.html);
    setThreads(loadPersistedThreads(deckKeyRef.current));
    briefRef.current = loadPersistedBrief(deckKeyRef.current);
    aiFilesRef.current = null;
    setHasAiSource(false);
    setSrcDoc(deck.html);
    setStatus(`Loaded ${deck.entryName}`);
  }, []);

  // Install once: capture otherwise-invisible runtime errors into the log.
  useEffect(() => installGlobalErrorCapture(), []);

  // Wizard finished: auto-load the generated deck in memory and remember its
  // brief + raw files. The 4 files also live in the local-dir backend server-side.
  const onGenerated = useCallback(
    (deck: GeneratedDeck) => {
      try {
        const loaded = buildDeckFromContents(deck.files);
        // Persist the brief under the deck's signature BEFORE loadDeck so it picks it up.
        persistBrief(deckSignature(loaded.html), deck.brief);
        loadDeck(loaded);
        aiFilesRef.current = deck.files;
        briefRef.current = deck.brief;
        lastDeckIdRef.current = deck.deckId;
        persistLastDeck({ deckId: deck.deckId, files: deck.files, brief: deck.brief });
        setHasAiSource(true);
        setWizardOpen(false);
        setStatus(`${deck.mock ? "Demo" : "AI"}: ${deck.message}`);
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        logger.error("app", "Failed to load generated deck", msg);
        setStatus(`Could not load the generated deck: ${msg}`);
      }
    },
    [loadDeck]
  );

  const onDownloadAiSource = useCallback(() => {
    if (aiFilesRef.current) downloadDeckFiles(aiFilesRef.current);
  }, []);

  // Prompt-export mode: re-pull the current deck from generated/<deckId>/ after a
  // Claude Code session edited it on disk (the chat's "Reload deck" action).
  const onReloadDeck = useCallback(async () => {
    const id = lastDeckIdRef.current;
    if (!id) {
      setStatus("No deck to reload — generate or load an AI deck first.");
      return;
    }
    try {
      onGenerated(await loadGeneratedDeck(id));
      setStatus("Reloaded the deck from disk.");
    } catch (err) {
      setStatus(`Reload failed: ${String((err as Error)?.message ?? err)}`);
    }
  }, [onGenerated]);

  // On launch, recall the user's last working deck (the future per-user backend;
  // localStorage for now) so they land in their deck, not an empty canvas.
  useEffect(() => {
    if (deckRef.current) return;
    const last = loadLastDeck();
    if (!last) return;
    try {
      const loaded = buildDeckFromContents(last.files);
      lastDeckIdRef.current = last.deckId;
      loadDeck(loaded);
      aiFilesRef.current = last.files;
      briefRef.current = last.brief;
      setHasAiSource(true);
      setStatus("Welcome back — restored your last deck.");
    } catch (err) {
      logger.warn("app", "Failed to restore last deck", String((err as Error)?.message ?? err));
      clearLastDeck();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onOpenFolder = useCallback(async () => {
    try {
      loadDeck(await openDeckViaPicker());
      clearLastDeck(); // disk decks are reopened by the user, not auto-restored
    } catch (err) {
      setStatus(`Open failed: ${(err as Error).message}`);
    }
  }, [loadDeck]);

  const onOpenFiles = useCallback(
    async (files: FileList) => {
      try {
        loadDeck(await openDeckFromFileList(files));
        clearLastDeck();
      } catch (err) {
        setStatus(`Open failed: ${(err as Error).message}`);
      }
    },
    [loadDeck]
  );

  // Clear the canvas back to the empty welcome state: drop the live deck, its
  // selection/threads/brief/AI source, and forget the auto-restored last deck so
  // it doesn't come back on next launch. Mirrors loadDeck's teardown, to nothing.
  const onClearCanvas = useCallback(() => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    releaseDeck(deckRef.current);
    deckRef.current = null;
    deckKeyRef.current = "";
    aiFilesRef.current = null;
    briefRef.current = null;
    lastDeckIdRef.current = "";
    setThreads({});
    setSelection(EMPTY_SELECTION);
    setSlide({ current: 0, total: 0 });
    setHasAiSource(false);
    setSrcDoc(null);
    clearLastDeck();
    setStatus("Canvas cleared. Create a new deck to begin.");
  }, []);

  const onToggleEdit = useCallback(() => {
    const next = !editModeRef.current;
    setEditMode(next);
    if (!next) setTool("select");
    bridge.setEditMode(next);
  }, [bridge]);

  const onSetTool = useCallback(
    (t: EditorTool) => {
      setTool(t);
      bridge.setTool(t);
    },
    [bridge]
  );

  const applyPatch = useCallback(
    (patch: Patch) => {
      if (!editModeRef.current) {
        setStatus("Edit Mode is OFF. Turn Edit ON before applying changes.");
        return;
      }
      bridge.applyPatch(patch);
    },
    [bridge]
  );

  const onAiEdit = useCallback(() => {
    if (!editModeRef.current) {
      setStatus("Turn Edit Mode ON before using AI Edit.");
      return;
    }
    if (!selection.id) {
      setStatus("Select one or more objects first, then click AI Edit.");
      return;
    }
    setAiOpen(true);
  }, [selection.id]);

  // Regenerate the deck's 3D background as a BRAND-NEW three_scene.js (real new
  // animation code) and hot-swap it in. This is the true "make it a totally
  // different animation" path — distinct from the sceneParam knobs, which can only
  // retune spin/opacity/colors/brightness. Returns a chat-style summary.
  const onRegenerateScene = useCallback(
    async (prompt: string): Promise<{ message: string; keys: string[]; mock: boolean }> => {
      const deck = deckRef.current;
      if (!deck) throw new Error("Load a deck first.");
      const currentSceneJs =
        aiFilesRef.current?.threeSceneJs ?? (deck.files.has("three_scene.js") ? await deck.files.get("three_scene.js")!.text() : undefined);

      // No 3D yet → ADD a layer: author a fresh scene (no currentSceneJs) and inject
      // the canvas/container/script scaffold so the deck gains an AI-editable 3D
      // background. Requires an AI deck (we rebuild + persist from its source files).
      const isAdd = !currentSceneJs;
      if (isAdd && !aiFilesRef.current) {
        throw new Error("Adding a 3D background is available for AI-generated decks. Generate a deck first.");
      }

      const result = await requestSceneRegen(prompt, briefRef.current ?? undefined, currentSceneJs);
      void appendDeckPrompt(lastDeckIdRef.current, { kind: "scene-regen", prompt, summary: result.threeDMotif });

      if (isAdd) {
        // Inject the scaffold into the source HTML, attach the new file, and rebuild
        // the deck so three.js + three_scene.js load and __htmlPptScene appears.
        const base = aiFilesRef.current!;
        const files: DeckFiles = {
          ...base,
          indexHtml: injectThreeScaffold(base.indexHtml),
          threeSceneJs: result.threeSceneJs,
        };
        const next = buildDeckFromContents(files);
        releaseDeck(deck);
        deckRef.current = next;
        aiFilesRef.current = files;
        setSelection(EMPTY_SELECTION);
        setSrcDoc(next.html + "\n<!-- scene-added -->");
      } else {
        // Hot-swap three_scene.js and reload the iframe so the new scene runs.
        const next = replaceDeckAsset(deck, "three_scene.js", result.threeSceneJs, "text/javascript");
        deckRef.current = next;
        setSelection(EMPTY_SELECTION);
        setSrcDoc(next.html + "\n<!-- scene-regen -->");
        if (aiFilesRef.current) aiFilesRef.current = { ...aiFilesRef.current, threeSceneJs: result.threeSceneJs };
      }

      // Persist: update brief motif so the change survives reload/restore (AI decks).
      if (aiFilesRef.current) {
        if (briefRef.current) briefRef.current = { ...briefRef.current, threeDMotif: result.threeDMotif };
        persistLastDeck({ deckId: lastDeckIdRef.current, files: aiFilesRef.current, brief: briefRef.current });
      }

      const usage = result.usage ? ` · ${formatUsage(result.usage)}` : "";
      const verb = isAdd ? "Added 3D background" : "new 3D animation";
      setStatus(`${result.mock ? "Demo" : "AI"}: ${result.message}${usage}`);
      return { message: `${result.message} (${verb}: ${result.threeDMotif})`, keys: [isAdd ? "scene:added" : "scene:regenerated"], mock: result.mock };
    },
    []
  );

  // Toolbar "Add 3D background" — just ADD a starter 3D layer (NO AI call): inject
  // the canvas scaffold + a minimal starter three_scene.js so the layer exists, is
  // selectable (Layers picker / auto-selected here), and is AI-editable. Works for
  // any loaded deck (AI or disk). The user then uses AI 3D mode to author the
  // animation they actually want.
  const onAdd3D = useCallback(() => {
    const deck = deckRef.current;
    if (!deck) {
      setStatus("Load a deck first.");
      return;
    }
    if (deck.files.has("three_scene.js") || /three-canvas-container/.test(deck.html)) {
      setStatus("This deck already has a 3D background layer.");
      return;
    }
    try {
      const next = addThreeSceneToDeck(deck, DEFAULT_THREE_SCENE_JS);
      deckRef.current = next;
      // AI decks: also inject into the persisted source so it survives reload/restore.
      if (aiFilesRef.current) {
        aiFilesRef.current = {
          ...aiFilesRef.current,
          indexHtml: injectThreeScaffold(aiFilesRef.current.indexHtml),
          threeSceneJs: DEFAULT_THREE_SCENE_JS,
        };
        if (briefRef.current) briefRef.current = { ...briefRef.current, threeDMotif: "starter particles" };
        persistLastDeck({ deckId: lastDeckIdRef.current, files: aiFilesRef.current, brief: briefRef.current });
      }
      pendingSelect3DRef.current = true; // auto-select once the iframe reloads
      setSelection(EMPTY_SELECTION);
      setSrcDoc(next.html + "\n<!-- scene-added -->");
      setStatus("3D layer added & selected. Open AI, switch on 3D mode, then describe the animation — or tune it in the Scene panel.");
    } catch (err) {
      setStatus(`Could not add 3D: ${(err as Error)?.message ?? err}`);
    }
  }, []);

  // --- Slide management (Phase 3) ------------------------------------------
  const refreshSlides = useCallback(async () => {
    if (!deckRef.current) {
      setSlidesList([]);
      return;
    }
    setSlidesList(((await bridge.listSlides()) as SlideSummary[]) ?? []);
  }, [bridge]);

  const onToggleSlides = useCallback(() => {
    setSlidesOpen((open) => {
      if (!open) void refreshSlides();
      return !open;
    });
  }, [refreshSlides]);

  // Keep the filmstrip in sync when the slide count changes (insert/delete) while open.
  useEffect(() => {
    if (slidesOpen) void refreshSlides();
  }, [slidesOpen, slide.total, refreshSlides]);

  const onGoToSlide = useCallback((index: number) => void bridge.goToSlide(index + 1), [bridge]);

  // Structural ops require edit mode (the editor gates mutations on it).
  const onInsertSlide = useCallback(
    async (index: number, position: InsertSlideSpec["position"], kind: "blank" | "duplicate") => {
      if (!editModeRef.current) return setStatus("Turn Edit Mode ON to change slides.");
      await bridge.insertSlide({ index, position, kind });
      await refreshSlides();
    },
    [bridge, refreshSlides]
  );

  const onDeleteSlide = useCallback(
    async (index: number) => {
      if (!editModeRef.current) return setStatus("Turn Edit Mode ON to change slides.");
      await bridge.deleteSlide(index);
      await refreshSlides();
    },
    [bridge, refreshSlides]
  );

  const onMoveSlide = useCallback(
    async (from: number, to: number) => {
      if (!editModeRef.current) return setStatus("Turn Edit Mode ON to change slides.");
      await bridge.moveSlide(from, to);
      await refreshSlides();
    },
    [bridge, refreshSlides]
  );

  // AI slide: author one new <section class="slide"> from a prompt (+ neighbour
  // slides as style context), then insert it (sanitized in the editor).
  const onAiInsertSlide = useCallback(
    async (index: number, position: InsertSlideSpec["position"], prompt: string) => {
      if (!editModeRef.current) return setStatus("Turn Edit Mode ON to add slides.");
      setSlideBusy(true);
      setStatus("Generating a slide…");
      try {
        let neighborHtml: string | undefined;
        try {
          const clean = (await bridge.getCleanHtml()) as string;
          const doc = new DOMParser().parseFromString(clean, "text/html");
          const secs = Array.from(doc.querySelectorAll<HTMLElement>("section.slide, .slide"));
          neighborHtml = [secs[index], secs[index + 1]].filter(Boolean).map((e) => e.outerHTML).join("\n");
        } catch {
          /* style context is best-effort */
        }
        const res = await requestSlide(prompt, briefRef.current ?? undefined, neighborHtml, {
          afterIndex: index + 1,
          total: slidesList.length,
        });
        void appendDeckPrompt(lastDeckIdRef.current, { kind: "edit", prompt: `[insert slide] ${prompt}` });
        await bridge.insertSlide({ index, position, kind: "html", html: res.html });
        await refreshSlides();
        const usage = res.usage ? ` · ${formatUsage(res.usage)}` : "";
        setStatus(`${res.mock ? "Demo" : "AI"}: ${res.message}${usage}`);
      } catch (err) {
        setStatus(`Could not generate slide: ${(err as Error)?.message ?? err}`);
      } finally {
        setSlideBusy(false);
      }
    },
    [bridge, refreshSlides, slidesList.length]
  );

  // Used by the chat: re-read the (possibly mutated) selection, fetch safe
  // per-object patches, apply them in one undo step, and summarize for the chat.
  const runAi = useCallback(
    async (
      prompt: string,
      opts?: { image?: boolean; sceneRegen?: boolean; elementRegen?: boolean }
    ): Promise<{ message: string; keys: string[]; mock: boolean; editExport?: EditExport }> => {
      // "Totally different 3D animation" intent → regenerate three_scene.js as new
      // code. Global (no selection needed) — handled before the selection check.
      if (opts?.sceneRegen) {
        return onRegenerateScene(prompt);
      }

      const ctxs = await bridge.getSelectionContexts();
      if (!ctxs || !ctxs.length) throw new Error("Select an object first, then ask.");

      // Selected the 3D background layer itself → the user wants to (re)generate the
      // animation, NOT patch the canvas element. Auto-route to scene regen regardless
      // of the 3D-mode toggle / prompt wording (an element patch on the canvas does
      // nothing visible — this was the "it doesn't apply to the background" bug).
      if (/id=["']three-canvas-container/.test(ctxs[0]?.outerHTML || "")) {
        return onRegenerateScene(prompt);
      }

      // Persist this modification prompt to the deck's durable server-side history.
      void appendDeckPrompt(lastDeckIdRef.current, {
        kind: opts?.elementRegen ? "element-regen" : opts?.image ? "edit-image" : "edit",
        prompt,
      });

      // "Rebuild from scratch" intent → regenerate ONE element's inner HTML. Scoped,
      // sanitized, one undo snapshot. Uses the primary selection.
      if (opts?.elementRegen) {
        const ctx = ctxs[0];
        if (!ctx?.id) throw new Error("Select a single object to rebuild.");
        const { html, message, mock } = await requestElementRegen(prompt, ctx, briefRef.current ?? undefined);
        await bridge.rebuildElement(ctx.id, html);
        setStatus(`${mock ? "Demo" : "AI"}: ${message}`);
        return { message, keys: ["element:rebuilt"], mock };
      }

      // "Pictures" intent → find REAL web images and paste one into EVERY selected
      // object (not generate one image for the last box). Inlined server-side.
      if (opts?.image) {
        const { ops, message, mock } = await requestAiImages(prompt, ctxs, briefRef.current ?? undefined);
        bridge.applyPatches(ops);
        setStatus(`${mock ? "Demo" : "AI"}: ${message}`);
        return { message, keys: Array.from(new Set(ops.flatMap((o) => Object.keys(o.patch)))), mock };
      }

      const { actions, message, mock, editExport } = await requestAiActions(
        prompt,
        ctxs,
        briefRef.current ?? undefined,
        lastDeckIdRef.current || undefined
      );
      // Prompt-export mode: nothing to apply — hand the JSON instruction to the chat
      // so the user can run it in Claude Code, then "Reload deck".
      if (editExport) {
        setStatus("Prompt-export mode — copy the JSON into a Claude Code session.");
        return { message, keys: [], mock, editExport };
      }
      bridge.applyActions(actions);
      setStatus(`${mock ? "Demo" : "AI"}: ${message}`);
      // Summarize the heterogeneous batch for the chat: patch keys + verb/block labels.
      const keys = Array.from(
        new Set(
          actions.flatMap((a) => {
            if (a.type === "patch") return Object.keys(a.patch);
            if (a.type === "layout") return [`layout:${a.op}`];
            if (a.type === "sceneParam") return [`scene:${a.key}`];
            if (a.type === "chart") return [`chart:${a.chartType}`];
            return [`block:${a.blockType}`];
          })
        )
      );
      const summary = actions.length > 1 ? `${message} · ${actions.length} actions` : message;
      return { message: summary, keys, mock };
    },
    [bridge, onRegenerateScene]
  );

  // Background picker: the animated background can't be clicked (pointer-events:
  // none, behind the slides), so the shell lists the layers and selects by id.
  const onListBackgrounds = useCallback(
    async (): Promise<BackgroundLayer[]> => (await bridge.listBackgroundLayers()) ?? [],
    [bridge]
  );
  const onSelectLayer = useCallback(
    (id: string) => {
      if (!editModeRef.current) {
        setStatus("Turn Edit Mode ON to select a background layer.");
        return;
      }
      bridge.selectById(id);
    },
    [bridge]
  );

  // Scene panel: tune the deck's 3D / canvas background animation (returns [] for
  // decks that expose no scene controller, which hides the panel).
  const onListSceneParams = useCallback(
    async (): Promise<SceneParamInfo[]> => (await bridge.listSceneParams()) ?? [],
    [bridge]
  );
  const onApplySceneParam = useCallback(
    (op: SceneParamOp) => {
      if (!editModeRef.current) {
        setStatus("Turn Edit Mode ON to tune the background animation.");
        return;
      }
      bridge.applySceneParam(op);
    },
    [bridge]
  );

  // Per-section 3D scenes: list the deck's scenes + current mapping, and assign one
  // (the deck crossfades + persists). Returns unavailable for single-scene decks.
  const onListSceneSections = useCallback(
    async (): Promise<SceneSectionInfo> =>
      (await bridge.listSceneSections()) ?? { available: false, scenes: [], sections: [] },
    [bridge]
  );
  const onApplySceneAssignment = useCallback(
    (op: SceneAssignOp) => {
      if (!editModeRef.current) {
        setStatus("Turn Edit Mode ON to change per-section 3D scenes.");
        return;
      }
      bridge.applySceneAssignment(op);
    },
    [bridge]
  );

  // Universal CSS-animation control — works on any deck with animated background
  // layers (no scene contract required).
  const onListBackgroundMotion = useCallback(
    async (): Promise<BackgroundMotionInfo> =>
      (await bridge.listBackgroundMotion()) ?? { available: false, playing: true, speed: 1 },
    [bridge]
  );
  const onApplyBackgroundMotion = useCallback(
    (op: BackgroundMotionOp) => {
      if (!editModeRef.current) {
        setStatus("Turn Edit Mode ON to control the background animation.");
        return;
      }
      bridge.applyBackgroundMotion(op);
    },
    [bridge]
  );

  const withCleanHtml = useCallback(
    async (action: (html: string) => Promise<void> | void) => {
      if (!deckRef.current) {
        setStatus("Load a deck first.");
        return;
      }
      const html = (await bridge.getCleanHtml()) as string;
      if (!html) {
        setStatus("Could not read HTML from the live preview.");
        return;
      }
      await action(html);
    },
    [bridge]
  );

  const onSaveHtml = useCallback(
    () =>
      withCleanHtml(async (html) => {
        const deck = deckRef.current!;
        if (deck.dirHandle) {
          await saveHtmlInPlace(deck, html);
          setStatus(`Saved ${deck.entryName} in place. CSS/JS unchanged.`);
        } else {
          downloadHtml(html, deck.entryName || "edited_index.html");
          setStatus("No folder handle (files were uploaded). Downloaded edited HTML instead.");
        }
      }),
    [withCleanHtml]
  );

  const onExportHtml = useCallback(
    () => withCleanHtml((html) => downloadHtml(html, "edited_index.html")),
    [withCleanHtml]
  );

  const onExportProject = useCallback(
    () =>
      withCleanHtml(async (html) => {
        await exportProjectToDirectory(deckRef.current!, html);
        setStatus("Exported project folder (CSS/JS/assets copied, edited HTML written).");
      }),
    [withCleanHtml]
  );

  const onExportStandalone = useCallback(
    () =>
      withCleanHtml(async (html) => {
        await exportStandaloneHtml(deckRef.current!, html);
        setStatus("Exported standalone HTML (CSS/JS/assets inlined into one file).");
      }),
    [withCleanHtml]
  );

  const onReload = useCallback(() => {
    const deck = deckRef.current;
    if (!deck) return;
    // Re-set srcDoc to a fresh string instance so the iframe remounts and the
    // editor re-injects.
    setSrcDoc(deck.html + "\n<!-- reload -->");
    setSelection(EMPTY_SELECTION);
  }, []);

  return (
    <div className="app">
      <Toolbar
        hasDeck={!!srcDoc}
        hasSelection={!!selection.id}
        selectionCount={selection.selectionCount ?? (selection.id ? 1 : 0)}
        editMode={editMode}
        tool={tool}
        slide={slide}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        hasAiSource={hasAiSource}
        onNewDeck={() => setWizardOpen(true)}
        onClearCanvas={onClearCanvas}
        onDownloadAiSource={onDownloadAiSource}
        onOpenFolder={onOpenFolder}
        onOpenFiles={onOpenFiles}
        onToggleEdit={onToggleEdit}
        onSetTool={onSetTool}
        onListBackgrounds={onListBackgrounds}
        onSelectLayer={onSelectLayer}
        onListSceneParams={onListSceneParams}
        onApplySceneParam={onApplySceneParam}
        onListSceneSections={onListSceneSections}
        onApplySceneAssignment={onApplySceneAssignment}
        onAdd3D={onAdd3D}
        onListBackgroundMotion={onListBackgroundMotion}
        onApplyBackgroundMotion={onApplyBackgroundMotion}
        onPrev={() => bridge.prevSlide()}
        onNext={() => bridge.nextSlide()}
        onToggleSlides={onToggleSlides}
        slidesOpen={slidesOpen}
        onDuplicate={() => bridge.duplicateSelected()}
        onDelete={() => bridge.deleteSelected()}
        onBringFront={() => bridge.bringFront()}
        onSendBack={() => bridge.sendBack()}
        onLayout={(spec) => bridge.applyLayout(spec)}
        onInsertBlock={(blockType) => bridge.insertBlock({ blockType, slots: [] })}
        onInsertImage={(src) => bridge.insertImage({ src })}
        onAiEdit={onAiEdit}
        onUndo={() => bridge.undo()}
        onRedo={() => bridge.redo()}
        onSaveHtml={onSaveHtml}
        onExportProject={onExportProject}
        onExportStandalone={onExportStandalone}
        onExportHtml={onExportHtml}
        onReload={onReload}
        onHelp={() => setHelpOpen(true)}
      />

      <div className={`deck-pane${slidesOpen && srcDoc ? " with-slides" : ""}`}>
        {slidesOpen && srcDoc && (
          <SlidesPanel
            slides={slidesList}
            current={Math.max(0, (slide.current || 1) - 1)}
            busy={slideBusy}
            onClose={() => setSlidesOpen(false)}
            onGoTo={onGoToSlide}
            onInsert={(i, p, k) => void onInsertSlide(i, p, k)}
            onAiInsert={(i, p, t) => void onAiInsertSlide(i, p, t)}
            onDelete={(i) => void onDeleteSlide(i)}
            onMove={(f, t) => void onMoveSlide(f, t)}
          />
        )}
        <div className="deck-stage">
          {srcDoc ? (
            <DeckFrame ref={iframeRef} srcDoc={srcDoc} />
          ) : (
            <div className="deck-empty">
              <div className="empty-card">
                <div className="empty-icon"><SparkleIcon width={26} height={26} /></div>
                <h2>Let's make your presentation</h2>
                <p>Describe your topic and AI builds a polished, on-brand deck in about a minute. You can fine-tune everything afterward.</p>
                <button className="empty-cta" onClick={() => setWizardOpen(true)}>
                  <SparkleIcon width={17} height={17} /> Create with AI
                </button>
                <button className="empty-link" onClick={onOpenFolder}>or open an existing deck</button>
              </div>
            </div>
          )}
          {editMode && selection.id && (
            <Inspector selection={selection} onPatch={applyPatch} onClose={() => bridge.deselect()} />
          )}
        </div>
      </div>

      <div className="statusbar">{status}</div>

      {aiOpen && editMode && (
        <AiChat
          subtitle={
            (selection.selectionCount ?? 0) > 1
              ? `Editing ${selection.selectionCount} objects`
              : selection.id
              ? `Editing ${selection.tag ?? ""}${
                  String(selection.className ?? "").split(" ").filter(Boolean)[0]
                    ? "." + String(selection.className).split(" ").filter(Boolean)[0]
                    : ""
                }`
              : "No object selected"
          }
          onClose={() => setAiOpen(false)}
          runAi={runAi}
          threadKey={selectionKey(selection)}
          messages={threads[selectionKey(selection)] ?? []}
          onAppend={appendMessage}
          onResolveThreadKey={resolveThreadKey}
          onReloadDeck={onReloadDeck}
        />
      )}

      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}

      {wizardOpen && <NewDeckWizard onClose={() => setWizardOpen(false)} onGenerated={onGenerated} />}
    </div>
  );
}
