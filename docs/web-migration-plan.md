# Web Migration Plan — PyQt6 → TypeScript (React + Vite)

Target: port the current PyQt6 desktop prototype into a **web-deployable** TypeScript app, preserving the editor's behavior and its core safety invariant.

Decisions locked for this plan:
- **Shell framework:** React + Vite (TypeScript)
- **Deck rendering:** `<iframe>` isolation (mirrors the current `QWebEngineView` model)
- **AI:** serverless proxy holding the OpenAI key; validator runs server-side too

> **Status (2026-06-01):** migration complete. The web app now **is** the
> project — it was flattened to the repo root and all PyQt code was removed. All
> phases in §8 are done as a first cut: scaffold, editor core, postMessage
> bridge, React shell (Toolbar/Inspector/AiPromptDialog), file I/O, serverless
> AI proxy with mock fallback, and dark theme. `npm run build` and `npm run
> typecheck` pass. See `README.md` to run it. Known limitations are tracked at
> the bottom of that README (notably CSS `url(...)` asset rewriting). The
> sections below remain the design rationale; paths that read `web/<x>` now live
> at the repo root as `<x>`.

> Note: `requirements.txt` pins **PyQt6** (the QSS file carries a legacy PyQt5-selectors comment). The port is from the PyQt6 codebase.

---

## 1. Why this port is tractable

The expensive, behavior-critical part — `editor_bridge.js` — is **already vanilla JS running in Chromium**. The web port keeps that logic and re-homes everything around it:

| Current (PyQt6) | Web target | Effort |
|---|---|---|
| `editor_js/editor_bridge.js` | `src/editor/*` (TS, runs **inside the iframe**) | Mechanical TS conversion |
| `bridge.py` (`QWebChannel`) | `postMessage` RPC layer (`src/editor/rpc.ts` ↔ `src/app/hooks/useEditorBridge.ts`) | Rewrite (small) |
| `main_window.py` toolbar/orchestration | `src/app/components/Toolbar.tsx` + `App.tsx` | Rewrite as React |
| `inspector.py` | `src/app/components/Inspector.tsx` | Rewrite as React |
| `ai/dialog.py` | `src/app/components/AiPromptDialog.tsx` | Rewrite as React |
| `ai/client.py` (OpenAI call) | `api/ai-edit.ts` serverless function | Rewrite (server-side) |
| `ai/validator.py` | `shared/validator.ts` (used by client **and** server) | Port + dedupe |
| `ai/worker.py` (`QThread`) | plain `async/await` | **Deleted** — no thread needed |
| `services/project_io.py` | `src/app/io/project-io.ts` (File System Access API) | Rewrite |
| `themes/*.qss` | `src/app/theme/*.css` | Manual restyle |

---

## 2. Target folder structure

```
web/
├─ index.html                 # React mount point (the app shell, NOT the deck)
├─ package.json
├─ vite.config.ts             # two build targets: app + editor IIFE (see §5)
├─ tsconfig.json
│
├─ shared/                    # imported by frontend AND serverless — single source of truth
│  ├─ patch-keys.ts           # the ONE definition of editable keys (fixes the 3-place drift)
│  ├─ patch-schema.ts         # JSON schema for the OpenAI structured output
│  └─ validator.ts            # ported validate_ai_patch — runs in both browser and server
│
├─ src/
│  ├─ types/
│  │  ├─ patch.ts             # Patch, PatchKey
│  │  ├─ context.ts          # SelectionPayload, SelectedContext (from payload()/selectedContext())
│  │  └─ messages.ts          # RPC command/event/response union types
│  │
│  ├─ editor/                 # ← ported editor_bridge.js. Bundled separately, injected into the iframe.
│  │  ├─ index.ts             # IIFE entry; guards double-injection (window.__htmlPptEditor)
│  │  ├─ state.ts             # STATE object
│  │  ├─ selection.ts         # normalizeTarget, BLOCK_SELECTOR, isGenericEditableObject
│  │  ├─ overlay.ts           # selection box / label / resize handle / toast
│  │  ├─ drag-resize.ts       # prepareForMove, moveBy, resize (NO transform, NO reparent)
│  │  ├─ text-nodes.ts        # TreeWalker text-node editing (preserves nested tags)
│  │  ├─ slides.ts            # IntersectionObserver slide tracking + animation replay
│  │  ├─ apply-patch.ts       # applyPatch (the single mutation funnel)
│  │  ├─ clean-html.ts        # getCleanHtml (strip editor artifacts)
│  │  └─ rpc.ts               # iframe side of postMessage protocol
│  │
│  └─ app/                    # ← the React shell (parent document)
│     ├─ main.tsx
│     ├─ App.tsx
│     ├─ components/
│     │  ├─ DeckFrame.tsx      # the <iframe>; loads deck + injects editor bundle
│     │  ├─ Toolbar.tsx
│     │  ├─ Inspector.tsx      # debounced patch queue + palette + color picker
│     │  └─ AiPromptDialog.tsx
│     ├─ hooks/
│     │  ├─ useEditorBridge.ts # parent side RPC client (replaces QWebChannel)
│     │  └─ useSelection.ts    # subscribes to selection/mutation events
│     ├─ ai/
│     │  └─ client.ts          # fetch('/api/ai-edit'); no key in browser
│     ├─ io/
│     │  └─ project-io.ts      # open/save/export via File System Access API
│     └─ theme/
│        └─ kakao-dark.css
│
└─ api/
   └─ ai-edit.ts              # serverless fn: holds OPENAI_API_KEY, validates, returns safe patch
```

---

## 3. The safety invariant survives — and improves

The current system has the patch key set **duplicated in three files that must stay in sync** (`ai/client.py`, `ai/validator.py`, `editor_bridge.js`). The port collapses this:

```ts
// shared/patch-keys.ts — the single source of truth
export const PATCH_KEYS = [
  'text','x','y','w','h','fontSize','color','backgroundColor',
  'borderColor','borderWidth','borderStyle','borderRadius',
  'fontWeight','lineHeight','letterSpacing','opacity','zIndex',
] as const;
export type PatchKey = typeof PATCH_KEYS[number];
export type Patch = Partial<Record<PatchKey, string | number>>;
```

- `shared/validator.ts` imports it → sanitization gate.
- `shared/patch-schema.ts` imports it → OpenAI structured-output schema.
- `src/editor/apply-patch.ts` imports it → the DOM mutation funnel.

One definition, three consumers, all type-checked. **Adding an editable property becomes a one-line change** instead of a three-file hunt.

The trust boundary is now **defense-in-depth**: `shared/validator.ts` runs on the serverless side (authoritative gate before the patch leaves the server) *and* on the client (before `applyPatch`). Untrusted AI output is sanitized twice.

---

## 4. Replacing QWebChannel: the postMessage RPC layer

`QWebChannel` gave bidirectional JS↔Python messaging. On the web, the deck lives in an iframe, so parent↔iframe communication is `postMessage`. Two directions:

**Parent → iframe (commands, some needing a return value).** `getCleanHtml` / `getSelectedContext` returned values to Python; those become promise-based request/response with a correlation id.

**iframe → parent (events).** The current `selectedChanged` / `mutationChanged` / `slideChanged` / `log` signals become fire-and-forget events.

```ts
// src/types/messages.ts
export type Command =
  | { kind: 'cmd'; id: number; method: 'applyPatch'; args: [Patch] }
  | { kind: 'cmd'; id: number; method: 'setEditMode'; args: [boolean] }
  | { kind: 'cmd'; id: number; method: 'setTool'; args: ['select'|'text'|'rect'] }
  | { kind: 'cmd'; id: number; method: 'duplicateSelected'|'deleteSelected'|'bringFront'|'sendBack'|'prevSlide'|'nextSlide'; args: [] }
  | { kind: 'cmd'; id: number; method: 'goToSlide'; args: [number] }
  | { kind: 'cmd'; id: number; method: 'getCleanHtml'|'getSelectedContext'; args: [] };

export type Response = { kind: 'res'; id: number; result: unknown };

export type EditorEvent =
  | { kind: 'evt'; name: 'selection'|'mutation'; payload: SelectionPayload }
  | { kind: 'evt'; name: 'slide'; payload: { current: number; total: number } }
  | { kind: 'evt'; name: 'log'; payload: string };
```

- `useEditorBridge.ts` (parent) keeps a `Map<id, resolve>` and turns `getCleanHtml()` into `await bridge.call('getCleanHtml')`.
- `src/editor/rpc.ts` (iframe) listens for commands, dispatches to the editor API, and posts events/responses back.
- **Origin discipline:** the iframe is loaded same-origin (via blob/`srcdoc`, see §5), so injection works and `postMessage` can pin a concrete `targetOrigin` instead of `'*'`.

This collapses `bridge.py`'s JSON-parse-and-re-emit dance into a typed channel with no Python in the middle.

---

## 5. Loading the deck + injecting the editor (the iframe)

Current flow: `QWebEngineView.load(file://…)` → `loadFinished` → `inject_editor_js()` runs the editor string + loads `qwebchannel.js`. Web equivalent in `DeckFrame.tsx`:

1. User opens a deck (folder/files via §7). Its `index.html` + assets are turned into an **object URL set** (rewrite relative `href`/`src` to blob URLs, or serve via a same-origin service worker) so the iframe is same-origin and editable.
2. Set `iframe.src` (or `srcdoc`) to the deck HTML.
3. On `iframe.onload`, inject the **editor bundle** as a `<script>` into the iframe document — exactly analogous to today's string injection, but now it's a real Vite build artifact.
4. The editor's `rpc.ts` boots and the parent's `useEditorBridge` handshakes.

**Vite needs two build outputs:**
- the **app** (React shell) — normal Vite build.
- the **editor** — a single self-contained **IIFE** bundle (`build.lib` / a second Rollup input) with no imports that survive at runtime, because it's injected into a foreign document. `shared/*` gets bundled *into* it.

`qwebchannel.js` is **dropped entirely** — its job (the transport) is now native `postMessage`.

The hard constraints from `editor_bridge.js` carry over unchanged and must be preserved in the TS port:
- never reparent elements, never overwrite `transform` (deck `.anim` / `.in-view` animations depend on it),
- selection never mutates the DOM (lazy `prepareForMove` on first >5px drag),
- text editing rewrites **text nodes** via `TreeWalker`, never `innerHTML`,
- `getCleanHtml` strips all `data-html-ppt-*` artifacts before export,
- Edit-OFF is a fully clean presentation view.

---

## 6. AI: serverless proxy

Browser code can't hold `OPENAI_API_KEY`. Flow becomes:

```
AiPromptDialog (React)
  → src/app/ai/client.ts:  POST /api/ai-edit { prompt, context }
      → api/ai-edit.ts (serverless):
          - reads OPENAI_API_KEY from env (server-only)
          - calls OpenAI Responses API with shared/patch-schema.ts
          - runs shared/validator.ts  ← authoritative sanitization
          - returns { patch, message }
  ← client re-runs shared/validator.ts (defense in depth)
  → bridge.call('applyPatch', patch)
```

- `ai/worker.py` (the `QThread`) is **deleted** — `fetch` is already async; React just `await`s and shows a spinner. No UI-freeze problem exists on the web.
- **Mock mode preserved:** if the serverless function sees no key, it returns the deterministic mock patch (port `_mock_patch`, including the bilingual Korean/English keyword matching — 고급/premium, 크게/bigger, 가운데/center, etc.). This keeps the full UI flow testable with zero secrets, exactly like today.
- Hosting: any function platform (Vercel / Cloudflare Workers / Netlify). `OPENAI_API_KEY`, `HTML_PPT_AI_MODEL`, `OPENAI_BASE_URL`, `HTML_PPT_AI_TIMEOUT` move to the function's env vars.

---

## 7. File I/O on the web

`project_io.py` (open folder, find HTML entry, copy folder, write text) maps to browser capabilities:

| Desktop action | Web implementation |
|---|---|
| Open HTML / Open Folder | **File System Access API** (`showDirectoryPicker` / `showOpenFilePicker`); fallback `<input type="file" webkitdirectory>` |
| `find_html_entry` (index.html first) | same logic in TS over the picked directory handle |
| Save HTML in place | write back through the directory handle (needs user grant); fallback = download |
| Export HTML Only | `Blob` + download (or `showSaveFilePicker`) |
| Export Project (copy folder + write HTML) | re-zip the loaded asset set with edited HTML → download `.zip` (e.g. `fflate`/`zip.js`); or write through the directory handle |

Asset loading for the iframe (§5) reuses the same picked file handles to build the blob URL map.

---

## 8. Phased rollout

1. **Scaffold** — Vite + React + TS; `shared/` with `patch-keys`, `patch-schema`, `validator` (port `validator.py`, add a tiny test vector set). This locks the contract first.
2. **Editor core** — port `editor_bridge.js` into `src/editor/*` as the IIFE bundle. Verify standalone by injecting into `sample_deck/index.html` opened directly. No React yet.
3. **Bridge** — `rpc.ts` + `useEditorBridge.ts`; `DeckFrame.tsx` loads `sample_deck` and handshakes. Prove selection/mutation/slide events reach React.
4. **Shell UI** — `Toolbar.tsx`, `Inspector.tsx` (debounced queue + palette), edit-mode gating. Reach feature parity with the current desktop UI minus AI.
5. **File I/O** — `project-io.ts`; open arbitrary decks, save, export HTML, export zip.
6. **AI** — `api/ai-edit.ts` serverless + `AiPromptDialog.tsx` + mock fallback. Wire to `applyPatch`.
7. **Theme + deploy** — port the dark QSS to CSS; deploy static app + function; smoke-test on the sample deck.

Each phase is independently runnable, so the port never goes dark.

---

## 9. Risks / things to watch

- **Same-origin requirement for injection.** Cross-origin iframes can't be script-injected. The deck must be served same-origin (blob/srcdoc/service worker). This is the biggest structural difference from `file://` in QWebEngineView — settle it in phase 3.
- **Deck JS global collisions.** `QWebEngineView` gave a fresh JS realm per page; the iframe preserves that isolation — keep the deck in the iframe, never same-document, or deck scripts (Three.js, nav handlers) will collide with React.
- **`save-in-place` permissions.** Browsers require explicit user grants to write back to disk; "Save HTML" can't be silent like the desktop version. Plan the UX (re-prompt or fall back to download).
- **Korean content / encoding.** Keep everything UTF-8 end-to-end (it already is); preserve the bilingual AI keywords.
- **Editor bundle isolation.** The injected editor must not rely on app-side imports at runtime — everything it needs (incl. `shared/*`) must be bundled into the IIFE.

---

## 10. What gets deleted vs. rewritten vs. kept-as-logic

- **Deleted:** `app.py`, `bridge.py`, `ai/worker.py`, `qwebchannel.js` dependency, all PyQt/Qt imports.
- **Rewritten (new tech, same behavior):** toolbar, inspector, AI dialog, file I/O, theme, the OpenAI call.
- **Ported near-mechanically (logic preserved):** the entire `editor_bridge.js` editor and `validate_ai_patch`.
- **Improved:** the patch-key contract becomes a single shared module; the validator becomes a shared client+server gate.
```
