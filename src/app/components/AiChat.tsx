// Sleek chat-style AI panel. Floats bottom-right; multi-turn. Each user prompt
// is sent through `runAi`, which (re)reads the selected object, fetches a safe
// patch from the serverless proxy, applies it, and returns a short summary. The
// chat keeps the conversation visible instead of being a one-shot modal.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SparkleIcon, SendIcon, ImageIcon } from "./icons";

export interface ChatMsg {
  id: number;
  role: "user" | "ai" | "error";
  text: string;
  keys?: string[];
}

interface AiChatProps {
  subtitle: string;
  onClose: () => void;
  runAi: (prompt: string, opts?: { image?: boolean }) => Promise<{ message: string; keys: string[]; mock: boolean }>;
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
  "generate a fancier version",
  "replace with a minimalist illustration",
  "make it photorealistic",
  "이미지를 더 멋지게",
];

// Natural-language fallback so a typed "generate a fancier image" routes to image
// generation even without flipping the toggle.
const IMAGE_INTENT_RE =
  /\b(generate|create|draw|render|imagine)\b.*\b(image|picture|photo|illustration|art|version|background)\b|그려|이미지|사진|일러스트/i;

export function AiChat({ subtitle, onClose, runAi, threadKey, messages, onAppend, onResolveThreadKey }: AiChatProps) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);
  const [imageMode, setImageMode] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function sendPrompt(prompt: string, forceImage?: boolean) {
    if (!prompt || busy || !threadKey) return;
    // Upgrade to the durable marker-based key so this conversation persists past
    // reload/undo; the result lands on this thread even if the user switches.
    const key = (await onResolveThreadKey()) || threadKey;
    const image = forceImage ?? (imageMode || IMAGE_INTENT_RE.test(prompt));
    onAppend(key, { role: "user", text: prompt });
    setInput("");
    setBusy(true);
    try {
      const { message, keys, mock } = await runAi(prompt, { image });
      setDemo(mock);
      onAppend(key, { role: "ai", text: message, keys });
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
          <div className="ai-empty">Select an object in the deck to chat about it. Each object keeps its own history.</div>
        )}
        {threadKey && messages.length === 0 && (
          <div className="ai-empty">
            {imageMode
              ? "Generate an image to replace the selected object — or try one:"
              : "Describe a change to the selected object — or try one:"}
            <div className="ai-examples">
              {(imageMode ? IMAGE_PROMPTS : STYLE_PROMPTS).map((ex) => (
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
            </div>
          </div>
        ))}
        {busy && (
          <div className="ai-msg ai">
            <div className="ai-bubble ai-typing">
              {imageMode && <span className="ai-gen-note">Generating image…</span>}
              <span /><span /><span />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="ai-input">
        <button
          className={`ai-mode${imageMode ? " active" : ""}`}
          title={imageMode ? "Image generation: ON — prompts replace the object with a generated image" : "Switch to image generation"}
          aria-pressed={imageMode}
          disabled={busy || !threadKey}
          onClick={() => setImageMode((v) => !v)}
        >
          <ImageIcon />
        </button>
        <textarea
          autoFocus
          rows={1}
          value={input}
          placeholder={!threadKey ? "Select an object first…" : imageMode ? "Describe the image to generate…" : "Ask AI to edit…"}
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
