// Floating property panel. Appears only when an object is selected; dismissed
// with × (which deselects) or by clicking empty canvas. Changes auto-apply
// (debounced 120ms) through onPatch -> App -> bridge.applyPatch — the same
// funnel the AI uses. Deliberately minimal: position/size, font/z, text,
// and three color controls. No palette grids / apply buttons / toggles.

import { useEffect, useRef, useState } from "react";
import type { Patch } from "@shared/editing";
import { ANIMATION_NONE, ANIMATION_PRESETS, ANIMATION_DEFAULTS } from "@shared/editing";
import type { AnimationPreset } from "@shared/editing";
import type { SelectionPayload } from "@/types/context";

type ColorKey = "color" | "backgroundColor" | "borderColor";

interface InspectorProps {
  selection: SelectionPayload;
  onPatch: (patch: Patch) => void;
  onClose: () => void;
}

const toHex = (v: string) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : "#ffffff");

export function Inspector({ selection, onPatch, onClose }: InspectorProps) {
  // Whether this object holds editable text. Captured per-selection (sticky),
  // NOT read live: emptying the field flips the payload's textSafe to false,
  // and if we keyed the textarea off that it would unmount mid-edit, drop focus
  // to <body>, and let the next Backspace/Delete fall through to "delete the
  // element". Recomputed only when a different object is selected.
  const [canEditText, setCanEditText] = useState(!!selection.textSafe);

  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  const [w, setW] = useState(1);
  const [h, setH] = useState(1);
  const [fontSize, setFontSize] = useState(14);
  const [zIndex, setZIndex] = useState(0);
  const [color, setColor] = useState("");
  const [fill, setFill] = useState("");
  const [border, setBorder] = useState("");
  const [text, setText] = useState("");
  const [anim, setAnim] = useState<string>(ANIMATION_NONE);
  const [animDuration, setAnimDuration] = useState(0.6);
  const [animLoop, setAnimLoop] = useState(false);

  const loading = useRef(false);
  const pending = useRef<Patch>({});
  const pendingText = useRef<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Repopulate when a *different* object is selected (not on every mutation, so
  // we never clobber what the user is typing).
  useEffect(() => {
    loading.current = true;
    pending.current = {};
    pendingText.current = null;
    setX(Math.round(selection.x ?? 0));
    setY(Math.round(selection.y ?? 0));
    setW(Math.max(1, Math.round(selection.w ?? 1)));
    setH(Math.max(1, Math.round(selection.h ?? 1)));
    setFontSize(Math.max(1, Math.round(selection.fontSize ?? 14)));
    setZIndex(Math.round(selection.zIndex ?? 0));
    setColor(selection.color ?? "");
    setFill(selection.backgroundColor ?? "");
    setBorder(selection.borderColor ?? "");
    setText(selection.text ?? "");
    setCanEditText(!!selection.textSafe);
    const a = selection.animationName && selection.animationName !== ANIMATION_NONE ? selection.animationName : ANIMATION_NONE;
    setAnim(a);
    // The inline duration/loop aren't surfaced in the payload, so reflect the
    // preset's defaults as a best-effort starting point.
    const def = a !== ANIMATION_NONE ? ANIMATION_DEFAULTS[a as AnimationPreset] : undefined;
    setAnimDuration(def ? parseFloat(def.duration) : 0.6);
    setAnimLoop(def ? def.iterationCount === "infinite" : false);
    queueMicrotask(() => {
      loading.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.id]);

  function flush() {
    if (debounce.current) clearTimeout(debounce.current);
    const patch: Patch = { ...pending.current };
    pending.current = {};
    if (pendingText.current !== null && canEditText) {
      patch.text = pendingText.current;
      pendingText.current = null;
    }
    if (Object.keys(patch).length) onPatch(patch);
  }

  function queue(partial: Patch) {
    if (loading.current) return;
    pending.current = { ...pending.current, ...partial };
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(flush, 120);
  }

  function queueText(value: string) {
    setText(value);
    if (loading.current || !canEditText) return;
    pendingText.current = value;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(flush, 120);
  }

  function setColorField(key: ColorKey, value: string, setter: (s: string) => void) {
    setter(value);
    queue({ [key]: value.trim() } as Patch);
  }

  // Picking a preset sends the name plus a sensible default duration/loop so it
  // animates immediately; "none" clears the animation. Duration/loop edits ride
  // the same debounced queue as everything else.
  function pickAnimation(name: string) {
    setAnim(name);
    if (name === ANIMATION_NONE) {
      queue({ animationName: ANIMATION_NONE });
      return;
    }
    const def = ANIMATION_DEFAULTS[name as AnimationPreset];
    const loop = def.iterationCount === "infinite";
    setAnimDuration(parseFloat(def.duration));
    setAnimLoop(loop);
    queue({
      animationName: name,
      animationDuration: def.duration,
      animationIterationCount: def.iterationCount,
    });
  }

  function setDuration(n: number) {
    setAnimDuration(n);
    if (anim === ANIMATION_NONE) return;
    queue({ animationName: anim, animationDuration: `${n}s` });
  }

  function setLoop(on: boolean) {
    setAnimLoop(on);
    if (anim === ANIMATION_NONE) return;
    queue({ animationName: anim, animationIterationCount: on ? "infinite" : "1" });
  }

  const num = (label: string, value: number, set: (n: number) => void, key: keyof Patch) => (
    <label className="ip-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          set(n);
          queue({ [key]: n } as Patch);
        }}
      />
    </label>
  );

  const colorCtl = (label: string, key: ColorKey, value: string, set: (s: string) => void) => (
    <div className="ip-color">
      <span>{label}</span>
      <input
        type="color"
        value={toHex(value)}
        onChange={(e) => setColorField(key, e.target.value.toUpperCase(), set)}
        title={`${label} color`}
      />
      <input
        type="text"
        value={value}
        placeholder="—"
        onChange={(e) => setColorField(key, e.target.value, set)}
      />
    </div>
  );

  const cls = String(selection.className ?? "").split(" ").filter(Boolean)[0];

  return (
    <aside className="inspector-pop" role="dialog" aria-label="Properties">
      <header className="ip-head">
        <div className="ip-title">
          <span className="ip-tag">{selection.tag}</span>
          {cls && <span className="ip-class">.{cls}</span>}
        </div>
        <button className="ip-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
          ×
        </button>
      </header>

      <div className="ip-grid">
        {num("X", x, setX, "x")}
        {num("Y", y, setY, "y")}
        {num("W", w, setW, "w")}
        {num("H", h, setH, "h")}
        {num("Size", fontSize, setFontSize, "fontSize")}
        {num("Z", zIndex, setZIndex, "zIndex")}
      </div>

      {canEditText && (
        <textarea
          className="ip-text"
          value={text}
          placeholder="Text…"
          onChange={(e) => queueText(e.target.value)}
        />
      )}

      <div className="ip-colors">
        {colorCtl("Text", "color", color, setColor)}
        {colorCtl("Fill", "backgroundColor", fill, setFill)}
        {colorCtl("Border", "borderColor", border, setBorder)}
      </div>

      <div className="ip-anim">
        <label className="ip-field">
          <span>Anim</span>
          <select value={anim} onChange={(e) => pickAnimation(e.target.value)}>
            <option value={ANIMATION_NONE}>None</option>
            {ANIMATION_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="ip-field">
          <span>Dur (s)</span>
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={animDuration}
            disabled={anim === ANIMATION_NONE}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </label>
        <label className="ip-check" title="Loop forever">
          <input
            type="checkbox"
            checked={animLoop}
            disabled={anim === ANIMATION_NONE}
            onChange={(e) => setLoop(e.target.checked)}
          />
          <span>Loop</span>
        </label>
      </div>
    </aside>
  );
}
