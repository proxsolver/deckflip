// Sleek chat-style AI panel. Floats bottom-right; multi-turn. Each user prompt
// is sent through `runAi`, which (re)reads the selected object, fetches a safe
// patch from the serverless proxy, applies it, and returns a short summary. The
// chat keeps the conversation visible instead of being a one-shot modal.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SparkleIcon, SendIcon, ImageIcon } from "./icons";
import type { EditExport } from "../ai/client";

// Small inline cube glyph for the "3D scene" mode toggle (no shared icon yet).
function CubeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2 21 7v10l-9 5-9-5V7z" />
      <path d="M12 2v20M3 7l9 5 9-5" />
    </svg>
  );
}

// Wand glyph for the "rebuild element from scratch" mode toggle.
function WandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 4V2M15 10V8M11 6H9M21 6h-2M18 9l-1.5-1.5M18 3l-1.5 1.5M3 21l9-9M12.5 8.5 15.5 11.5" />
    </svg>
  );
}

export interface ChatMsg {
  id: number;
  role: "user" | "ai" | "error";
  text: string;
  keys?: string[];
  /** Prompt-export mode: a Claude Code edit instruction rendered as a copyable block. */
  editExport?: EditExport;
}

interface AiChatProps {
  subtitle: string;
  onClose: () => void;
  runAi: (
    prompt: string,
    opts?: { image?: boolean; sceneRegen?: boolean; elementRegen?: boolean }
  ) => Promise<{ message: string; keys: string[]; mock: boolean; editExport?: EditExport }>;
  /** Prompt-export mode: re-pull the deck after a Claude Code session edited it on disk. */
  onReloadDeck?: () => void | Promise<void>;
  /** Identifies the current object/selection; its own thread is shown. "" = nothing selected. */
  threadKey: string;
  /** Messages for the current threadKey (owned by the parent, so they persist across switches). */
  messages: ChatMsg[];
  /** Append a message to a specific thread (id assigned by the parent). */
  onAppend: (threadKey: string, msg: Omit<ChatMsg, "id">) => void;
  /** Assigns durable markers to the selection and returns its persistent key. */
  onResolveThreadKey: () => Promise<string>;
}

// Clickable starter prompts — they double as a cheat-sheet for what the offline
// demo engine understands (bilingual EN/KO).
const STYLE_PROMPTS = [
  "make it bigger",
  "premium look",
  "gold border",
  "warm beige background",
  "blur the background",
  "dim the background",
  "이 박스를 더 고급스럽게",
];
const IMAGE_PROMPTS = [
  "paste a real photo for each box",
  "find an official product image",
  "add a relevant photo",
  "각 박스에 어울리는 사진 넣어줘",
];
// Scene-mode starters: these REGENERATE the 3D background as new animation code
// (not the sceneParam knobs, which only retune the existing motion).
const SCENE_PROMPTS = [
  "make it a totally different animation",
  "flowing ribbons instead of particles",
  "calm, slow drifting fog",
  "완전히 다른 3D 배경 애니메이션으로",
];
// Rebuild-mode starters: these REGENERATE the selected element's inner HTML from
// scratch (advanced restyle/restructure), sanitized + scoped to that one node.
const REBUILD_PROMPTS = [
  "redesign this as a glassy stat card",
  "turn this into a clean 3-column layout",
  "make this a bold quote with a citation",
  "이 요소를 처음부터 고급스럽게 다시 디자인",
];

// Natural-language fallback so a typed "paste pictures for each box" routes to the
// web image-search path even without flipping the toggle. Verb (incl. paste/add/
// find/insert) + an image noun, or the Korean cues.
const IMAGE_INTENT_RE =
  /\b(generate|create|draw|render|imagine|paste|insert|add|find|fetch|put|place|search|get)\b.*\b(image|picture|photo|illustration|art|logo|icon|background)\b|그려|이미지|사진|일러스트|로고|아이콘/i;

// Conservative auto-route for "regenerate the 3D background animation" — requires
// BOTH a 3D/scene noun AND a change/new cue, so ordinary object edits ("make this
// bigger") and background-COLOR tweaks don't trip it. The explicit 3D toggle is
// the primary path; this catches the obvious phrasings. Note: once a scene has
// been regenerated, the panel sticks in 3D mode (see sendPrompt) so follow-ups
// like "make it fit a car brand" keep regenerating even without a 3D keyword.
const SCENE_INTENT_RE =
  /(?=.*(\b3d\b|three\.?js|입체|\b씬\b|\bscene\b))(?=.*(다르|딴|새로|새롭|완전히|재생성|재구성|재생|다시|바꾸|바꿔|갈아|교체|생성|만들|different|another|\bnew\b|fresh|regenerat|recreat|remake|\bredo\b|redesign|reimagin|reinvent|replace|again))/i;

// "Rebuild this element from scratch" intent — explicit rebuild/redesign verbs so
// it doesn't trip on ordinary tweaks. The wand toggle is the primary path.
const REBUILD_INTENT_RE =
  /\b(rebuild|re-?design|restructure|re-?make|overhaul|revamp|from scratch)\b|재설계|재구성|처음부터|새로 ?만들|싹 ?바꿔/i;

// Prompt-export mode: render the Claude Code edit instruction as a copyable JSON
// block + a "Reload deck" action to re-pull after Claude Code edits the deck on disk.
function EditExportBlock({ editExport, onReloadDeck }: { editExport: EditExport; onReloadDeck?: () => void | Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(editExport, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the user can select the text manually */
    }
  };
  return (
    <div className="ai-export">
      <div className="ai-export-hint">Paste this into a Claude Code session, then reload:</div>
      <pre className="ai-export-json">{json}</pre>
      <div className="ai-export-actions">
        <button className="ai-chip" onClick={copy}>{copied ? "Copied ✓" : "Copy JSON"}</button>
        {onReloadDeck && <button className="ai-chip" onClick={() => void onReloadDeck()}>Reload deck</button>}
      </div>
    </div>
  );
}

export function AiChat({ subtitle, onClose, runAi, threadKey, messages, onAppend, onResolveThreadKey, onReloadDeck }: AiChatProps) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);
  const [imageMode, setImageMode] = useState(false);
  // "3D scene" mode: prompts regenerate the deck's three_scene.js as brand-new
  // animation code. Mutually exclusive with image mode.
  const [sceneMode, setSceneMode] = useState(false);
  // "Rebuild" mode: prompts regenerate the selected element's inner HTML from
  // scratch. Mutually exclusive with image/scene modes.
  const [rebuildMode, setRebuildMode] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function sendPrompt(prompt: string, forceImage?: boolean) {
    if (!prompt || busy || !threadKey) return;
    // Upgrade to the durable marker-based key so this conversation persists past
    // reload/undo; the result lands on this thread even if the user switches.
    const key = (await onResolveThreadKey()) || threadKey;
    // Precedence: scene regen (global) → element rebuild (one object) → image search.
    const sceneRegen = sceneMode || SCENE_INTENT_RE.test(prompt);
    const elementRegen = !sceneRegen && (rebuildMode || REBUILD_INTENT_RE.test(prompt));
    const image = !sceneRegen && !elementRegen && (forceImage ?? (imageMode || IMAGE_INTENT_RE.test(prompt)));
    onAppend(key, { role: "user", text: prompt });
    setInput("");
    setBusy(true);
    try {
      const { message, keys, mock, editExport } = await runAi(prompt, { image, sceneRegen, elementRegen });
      setDemo(mock);
      onAppend(key, { role: "ai", text: message, keys, editExport });
      // Once a 3D background has been regenerated, STAY in 3D mode: follow-ups
      // ("make it fit a car brand", "이 스타일보다 다시") are almost always more
      // regeneration, not object edits — so don't fall back to sceneParam tuning.
      if (keys?.includes("scene:regenerated")) {
        setSceneMode(true);
        setImageMode(false);
      }
    } catch (err) {
      onAppend(key, { role: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function send() {
    sendPrompt(input.trim());
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="ai-chat" role="dialog" aria-label="AI assistant">
      <header className="ai-head">
        <div className="ai-head-title">
          <SparkleIcon /> <span>AI Edit</span>
          {demo && <span className="ai-badge" title="Offline demo engine — no real AI is being called">DEMO</span>}
        </div>
        <button className="ai-close" onClick={onClose} aria-label="Close" title="Close">×</button>
      </header>
      <div className="ai-sub">{subtitle}</div>

      <div className="ai-messages">
        {!threadKey && (
          <div className="ai-empty">
            {sceneMode
              ? "3D mode is on. Click any object in the deck, then ask again to regenerate the 3D background (the selection itself isn't used for 3D changes)."
              : "Select an object in the deck to chat about it. Each object keeps its own history."}
          </div>
        )}
        {threadKey && messages.length === 0 && (
          <div className="ai-empty">
            {sceneMode
              ? "Regenerate the deck's 3D background as a brand-new animation — or try one:"
              : rebuildMode
                ? "Rebuild the selected object from scratch (advanced redesign) — or try one:"
                : imageMode
                  ? "Find & paste real web images for the selected object(s) — or try one:"
                  : "Describe a change to the selected object — or try one:"}
            <div className="ai-examples">
              {(sceneMode ? SCENE_PROMPTS : rebuildMode ? REBUILD_PROMPTS : imageMode ? IMAGE_PROMPTS : STYLE_PROMPTS).map((ex) => (
                <button key={ex} className="ai-chip" disabled={busy} onClick={() => sendPrompt(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ai-msg ${m.role}`}>
            <div className="ai-bubble">
              {m.text}
              {m.keys && m.keys.length > 0 && <div className="ai-keys">{m.keys.join(" · ")}</div>}
              {m.editExport && <EditExportBlock editExport={m.editExport} onReloadDeck={onReloadDeck} />}
            </div>
          </div>
        ))}
        {busy && (
          <div className="ai-msg ai">
            <div className="ai-bubble ai-typing">
              {sceneMode && <span className="ai-gen-note">Regenerating the 3D background…</span>}
              {!sceneMode && rebuildMode && <span className="ai-gen-note">Rebuilding the element…</span>}
              {!sceneMode && !rebuildMode && imageMode && <span className="ai-gen-note">Searching the web for images…</span>}
              <span /><span /><span />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="ai-input">
        <button
          className={`ai-mode${imageMode ? " active" : ""}`}
          title={imageMode ? "Web images: ON — prompts find & paste real photos into the selected object(s)" : "Switch to web image search"}
          aria-pressed={imageMode}
          disabled={busy || !threadKey}
          onClick={() => { setImageMode((v) => !v); setSceneMode(false); setRebuildMode(false); }}
        >
          <ImageIcon />
        </button>
        <button
          className={`ai-mode${rebuildMode ? " active" : ""}`}
          title={rebuildMode ? "Rebuild: ON — prompts redesign the selected object's content from scratch (sanitized, one undo step)" : "Switch to rebuild-from-scratch"}
          aria-pressed={rebuildMode}
          disabled={busy || !threadKey}
          onClick={() => { setRebuildMode((v) => !v); setImageMode(false); setSceneMode(false); }}
        >
          <WandIcon />
        </button>
        <button
          className={`ai-mode${sceneMode ? " active" : ""}`}
          title={sceneMode ? "3D background: ON — prompts regenerate the moving 3D/canvas background as a brand-new animation" : "Switch to 3D background regeneration"}
          aria-pressed={sceneMode}
          disabled={busy || !threadKey}
          onClick={() => { setSceneMode((v) => !v); setImageMode(false); setRebuildMode(false); }}
        >
          <CubeIcon />
        </button>
        <textarea
          autoFocus
          rows={1}
          value={input}
          placeholder={
            !threadKey
              ? "Select an object first…"
              : sceneMode
                ? "Describe the new 3D background animation…"
                : rebuildMode
                  ? "Describe the new design for this object…"
                  : imageMode
                    ? "Describe the photo to find on the web…"
                    : "Ask AI to edit…"
          }
          disabled={busy || !threadKey}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="ai-send" disabled={busy || !input.trim() || !threadKey} onClick={send} aria-label="Send">
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
