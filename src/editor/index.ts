// Editor entry point. Built as a standalone IIFE (vite.editor.config.ts) and
// injected into the deck <iframe> at runtime — the web analogue of the string
// injection done by inject_editor_js() in the old PyQt main_window.py.

import { install, editorApi } from "./core";
import { bindRpc } from "./rpc";

declare global {
  interface Window {
    __htmlPptEditor?: typeof editorApi;
  }
}

(function boot() {
  if (window.__htmlPptEditor) {
    // Already injected on this document. Parent re-syncs edit mode after inject.
    return;
  }
  bindRpc(); // install the event emitter before anything emits
  install();
  window.__htmlPptEditor = editorApi;
  // Signal the parent that the editor is live and ready for commands.
  try {
    const origin = document.referrer ? new URL(document.referrer).origin : "*";
    window.parent?.postMessage({ kind: "evt", name: "ready", payload: null }, origin);
  } catch {
    window.parent?.postMessage({ kind: "evt", name: "ready", payload: null }, "*");
  }
})();
