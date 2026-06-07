// Slide-management filmstrip (Phase 3). A toggle-able rail beside the deck that
// lists every slide (number + title), lets the user jump to one, and — PowerPoint
// style — insert a new slide between any two: a blank, a duplicate, or an AI slide
// described in a prompt. Reorder/delete live on each card. All structural ops run
// through the editor bridge (one undo snapshot each); this component is pure UI.

import { useState } from "react";
import type { SlideSummary } from "@/types/context";

interface Props {
  slides: SlideSummary[];
  /** 0-based index of the slide currently in view. */
  current: number;
  /** True while an AI slide is being generated (disables insert affordances). */
  busy?: boolean;
  onClose: () => void;
  onGoTo: (index: number) => void;
  onInsert: (index: number, position: "before" | "after", kind: "blank" | "duplicate") => void;
  onAiInsert: (index: number, position: "before" | "after", prompt: string) => void;
  onDelete: (index: number) => void;
  onMove: (from: number, to: number) => void;
}

export function SlidesPanel(props: Props) {
  const { slides, current, busy } = props;
  // Which gap's insert menu is open, e.g. "0:before" / "3:after"; null = none.
  const [openGap, setOpenGap] = useState<string | null>(null);
  const [aiGap, setAiGap] = useState<string | null>(null);
  const [aiText, setAiText] = useState("");

  const gapKey = (index: number, position: "before" | "after") => `${index}:${position}`;

  const closeMenus = () => {
    setOpenGap(null);
    setAiGap(null);
    setAiText("");
  };

  const renderGap = (index: number, position: "before" | "after") => {
    const key = gapKey(index, position);
    const menuOpen = openGap === key;
    const aiOpen = aiGap === key;
    return (
      <div className="slides-gap">
        <button
          className="slides-gap-add"
          title="Insert a slide here"
          disabled={busy}
          onClick={() => {
            setAiGap(null);
            setOpenGap(menuOpen ? null : key);
          }}
        >
          +
        </button>
        {menuOpen && !aiOpen && (
          <div className="slides-gap-menu">
            <button
              onClick={() => {
                props.onInsert(index, position, "blank");
                closeMenus();
              }}
            >
              ＋ Blank slide
            </button>
            <button
              onClick={() => {
                props.onInsert(index, position, "duplicate");
                closeMenus();
              }}
            >
              ⧉ Duplicate this
            </button>
            <button onClick={() => setAiGap(key)}>✦ AI slide…</button>
          </div>
        )}
        {aiOpen && (
          <div className="slides-gap-ai">
            <textarea
              className="slides-ai-input"
              placeholder="Describe the slide to insert here…"
              value={aiText}
              autoFocus
              rows={3}
              disabled={busy}
              onChange={(e) => setAiText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && aiText.trim()) {
                  props.onAiInsert(index, position, aiText.trim());
                  closeMenus();
                }
                if (e.key === "Escape") closeMenus();
              }}
            />
            <div className="slides-ai-row">
              <button className="slides-ai-cancel" onClick={closeMenus} disabled={busy}>
                Cancel
              </button>
              <button
                className="slides-ai-go"
                disabled={busy || !aiText.trim()}
                onClick={() => {
                  props.onAiInsert(index, position, aiText.trim());
                  closeMenus();
                }}
              >
                {busy ? "Generating…" : "Insert with AI"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="slides-panel">
      <div className="slides-head">
        <span>Slides · {slides.length}</span>
        <button className="slides-close" title="Hide slide panel" onClick={props.onClose}>
          ×
        </button>
      </div>

      <div className="slides-list">
        {slides.length === 0 && <div className="slides-empty">No slides yet.</div>}
        {slides.map((s, i) => (
          <div key={i}>
            {renderGap(i, "before")}
            <div
              className={"slides-card" + (i === current ? " is-current" : "")}
              onClick={() => props.onGoTo(i)}
              title={s.title || `Slide ${i + 1}`}
            >
              <span className="slides-num">{i + 1}</span>
              <span className="slides-title">{s.title || <em>Untitled slide</em>}</span>
              <div className="slides-card-actions" onClick={(e) => e.stopPropagation()}>
                <button title="Move up" disabled={i === 0 || busy} onClick={() => props.onMove(i, i - 1)}>
                  ↑
                </button>
                <button
                  title="Move down"
                  disabled={i === slides.length - 1 || busy}
                  onClick={() => props.onMove(i, i + 1)}
                >
                  ↓
                </button>
                <button title="Duplicate" disabled={busy} onClick={() => props.onInsert(i, "after", "duplicate")}>
                  ⧉
                </button>
                <button
                  title="Delete slide"
                  disabled={slides.length <= 1 || busy}
                  onClick={() => props.onDelete(i)}
                >
                  ✕
                </button>
              </div>
            </div>
            {i === slides.length - 1 && renderGap(i, "after")}
          </div>
        ))}
      </div>
    </aside>
  );
}
