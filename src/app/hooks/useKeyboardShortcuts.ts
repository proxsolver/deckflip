// Global PowerPoint-style shortcuts handled at the app (parent) level. These
// fire when focus is in the React shell. When focus is inside the deck iframe,
// the editor's own keydown handler (src/editor/core.ts) handles the same set —
// the two never double-fire because they live in separate documents.

import { useEffect } from "react";
import type { EditorBridge } from "./useEditorBridge";

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

export function useKeyboardShortcuts(bridge: EditorBridge, enabled: boolean, hasSelection: boolean): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!enabled) return;
      if (isTypingTarget(e.target)) return; // let form fields keep native keys

      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        switch (e.key.toLowerCase()) {
          case "z":
            e.preventDefault();
            if (e.shiftKey) bridge.redo();
            else bridge.undo();
            return;
          case "y":
            e.preventDefault();
            bridge.redo();
            return;
          case "c":
            e.preventDefault();
            bridge.copySelected();
            return;
          case "x":
            e.preventDefault();
            bridge.cutSelected();
            return;
          case "v":
            e.preventDefault();
            bridge.paste();
            return;
          case "d":
            e.preventDefault();
            bridge.duplicateSelected();
            return;
        }
        if (e.key === "]") {
          e.preventDefault();
          bridge.bringFront();
          return;
        }
        if (e.key === "[") {
          e.preventDefault();
          bridge.sendBack();
          return;
        }
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        bridge.deleteSelected();
        return;
      }

      // Page Up/Down and Space always change slides.
      if (e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        bridge.nextSlide();
        return;
      }
      if (e.key === "PageUp") {
        e.preventDefault();
        bridge.prevSlide();
        return;
      }

      const isArrow = e.key.startsWith("Arrow");
      if (!isArrow) return;
      e.preventDefault();

      if (hasSelection) {
        // Arrows nudge the selected object (Shift = 10px).
        const step = e.shiftKey ? 10 : 1;
        const nudges: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const [dx, dy] = nudges[e.key];
        bridge.nudgeSelected(dx, dy);
      } else {
        // Nothing selected: arrows navigate slides.
        if (e.key === "ArrowDown" || e.key === "ArrowRight") bridge.nextSlide();
        else bridge.prevSlide();
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge, enabled, hasSelection]);
}
