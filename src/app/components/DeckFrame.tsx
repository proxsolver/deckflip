// Renders the deck in an isolated same-origin <iframe> (srcdoc) and injects the
// editor IIFE bundle after each load — the web analogue of QWebEngineView +
// inject_editor_js(). The deck's own CSS/JS stay sandboxed inside the iframe.

import { forwardRef, useRef } from "react";

let cachedBundle: string | null = null;
async function loadEditorBundle(): Promise<string> {
  if (cachedBundle) return cachedBundle;
  const resp = await fetch("/editor-bundle.js");
  if (!resp.ok) throw new Error("editor-bundle.js not found — run `npm run build:editor`.");
  cachedBundle = await resp.text();
  return cachedBundle;
}

interface DeckFrameProps {
  srcDoc: string | null;
}

export const DeckFrame = forwardRef<HTMLIFrameElement, DeckFrameProps>(function DeckFrame({ srcDoc }, ref) {
  const localRef = useRef<HTMLIFrameElement | null>(null);

  const setRefs = (node: HTMLIFrameElement | null) => {
    localRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  const handleLoad = () => {
    const iframe = localRef.current;
    if (!iframe || !srcDoc) return;
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) return;
    loadEditorBundle()
      .then((code) => {
        const script = doc.createElement("script");
        script.dataset.htmlPptEditor = "true";
        script.textContent = code;
        doc.body.appendChild(script);
      })
      .catch((err) => console.error(err));
  };

  return (
    <iframe
      ref={setRefs}
      className="deck-frame"
      title="deck"
      srcDoc={srcDoc ?? undefined}
      onLoad={handleLoad}
      // Allow the deck's scripts (Three.js etc.) and same-origin access so we
      // can inject the editor. The deck is user-supplied content they chose.
      sandbox="allow-scripts allow-same-origin allow-modals allow-popups"
    />
  );
});
