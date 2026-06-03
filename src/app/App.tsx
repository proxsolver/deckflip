// Application shell — the web equivalent of main_window.py. Owns deck loading,
// edit-mode/tool state, the AI flow, and save/export. All deck mutation goes
// through the editor bridge (postMessage), never by touching the iframe DOM.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Patch } from "@shared/patch-keys";
import type { EditorTool } from "@/types/messages";
import type { SelectionPayload, BackgroundLayer } from "@/types/context";
import type { SceneParamInfo, BackgroundMotionInfo, BackgroundMotionOp } from "@shared/scene-params";
import type { SceneParamOp } from "@shared/actions";
import { Toolbar } from "./components/Toolbar";
import { Inspector } from "./components/Inspector";
import { DeckFrame } from "./components/DeckFrame";
import { AiChat, type ChatMsg } from "./components/AiChat";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { useEditorBridge } from "./hooks/useEditorBridge";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { requestAiActions, requestAiImage } from "./ai/client";
import {
  openDeckViaPicker,
  openDeckFromFileList,
  releaseDeck,
  saveHtmlInPlace,
  downloadHtml,
  exportProjectToDirectory,
  exportStandaloneHtml,
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

function loadPersistedThreads(deckKey: string): Record<string, ChatMsg[]> {
  try {
    const raw = localStorage.getItem(THREADS_LS_PREFIX + deckKey);
    return raw ? (JSON.parse(raw) as Record<string, ChatMsg[]>) : {};
  } catch {
    return {};
  }
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
    },
    onSelection: (payload) => setSelection(payload),
    onMutation: (payload) => setSelection(payload),
    onSlide: (s) => setSlide(s),
    onHistory: (h) => setHistory(h),
    onLog: (msg) => setStatus(msg),
  });

  useKeyboardShortcuts(bridge, editMode && !!srcDoc, !!selection.id);

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
    // Restore this deck's durable chat threads (anchored to data-ai-id markers).
    deckKeyRef.current = deckSignature(deck.html);
    setThreads(loadPersistedThreads(deckKeyRef.current));
    setSrcDoc(deck.html);
    setStatus(`Loaded ${deck.entryName}`);
  }, []);

  const onOpenFolder = useCallback(async () => {
    try {
      loadDeck(await openDeckViaPicker());
    } catch (err) {
      setStatus(`Open failed: ${(err as Error).message}`);
    }
  }, [loadDeck]);

  const onOpenFiles = useCallback(
    async (files: FileList) => {
      try {
        loadDeck(await openDeckFromFileList(files));
      } catch (err) {
        setStatus(`Open failed: ${(err as Error).message}`);
      }
    },
    [loadDeck]
  );

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

  // Used by the chat: re-read the (possibly mutated) selection, fetch safe
  // per-object patches, apply them in one undo step, and summarize for the chat.
  const runAi = useCallback(
    async (
      prompt: string,
      opts?: { image?: boolean }
    ): Promise<{ message: string; keys: string[]; mock: boolean }> => {
      const ctxs = await bridge.getSelectionContexts();
      if (!ctxs || !ctxs.length) throw new Error("Select an object first, then ask.");

      // Image generation targets the primary selection (last in the array) only.
      if (opts?.image) {
        const primary = ctxs[ctxs.length - 1];
        const reference = await bridge.getSelectedImageData();
        const { ops, message, mock } = await requestAiImage(prompt, primary, reference);
        bridge.applyPatches(ops);
        setStatus(`${mock ? "Demo" : "AI"}: ${message}`);
        return { message, keys: Array.from(new Set(ops.flatMap((o) => Object.keys(o.patch)))), mock };
      }

      const { actions, message, mock } = await requestAiActions(prompt, ctxs);
      bridge.applyActions(actions);
      setStatus(`${mock ? "Demo" : "AI"}: ${message}`);
      // Summarize the heterogeneous batch for the chat: patch keys + verb/block labels.
      const keys = Array.from(
        new Set(
          actions.flatMap((a) => {
            if (a.type === "patch") return Object.keys(a.patch);
            if (a.type === "layout") return [`layout:${a.op}`];
            if (a.type === "sceneParam") return [`scene:${a.key}`];
            return [`block:${a.blockType}`];
          })
        )
      );
      const summary = actions.length > 1 ? `${message} · ${actions.length} actions` : message;
      return { message: summary, keys, mock };
    },
    [bridge]
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
        onOpenFolder={onOpenFolder}
        onOpenFiles={onOpenFiles}
        onToggleEdit={onToggleEdit}
        onSetTool={onSetTool}
        onListBackgrounds={onListBackgrounds}
        onSelectLayer={onSelectLayer}
        onListSceneParams={onListSceneParams}
        onApplySceneParam={onApplySceneParam}
        onListBackgroundMotion={onListBackgroundMotion}
        onApplyBackgroundMotion={onApplyBackgroundMotion}
        onPrev={() => bridge.prevSlide()}
        onNext={() => bridge.nextSlide()}
        onDuplicate={() => bridge.duplicateSelected()}
        onDelete={() => bridge.deleteSelected()}
        onBringFront={() => bridge.bringFront()}
        onSendBack={() => bridge.sendBack()}
        onLayout={(spec) => bridge.applyLayout(spec)}
        onInsertBlock={(blockType) => bridge.insertBlock({ blockType, slots: [] })}
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

      <div className="deck-pane">
        {srcDoc ? (
          <DeckFrame ref={iframeRef} srcDoc={srcDoc} />
        ) : (
          <div className="deck-empty">
            <div>No deck loaded.</div>
            <div>Use “Open Folder” (Chrome/Edge) or “Open Files…” to load a deck’s index.html + assets.</div>
          </div>
        )}
        {editMode && selection.id && (
          <Inspector selection={selection} onPatch={applyPatch} onClose={() => bridge.deselect()} />
        )}
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
        />
      )}

      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
