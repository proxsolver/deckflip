# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based editor for **AI-generated static HTML presentations** (decks built from `index.html` + `style.css` + `script.js` + optional `three_scene.js`). It renders a deck in an isolated `<iframe>` and layers selection, drag/resize, text-node editing, and AI patches on top — without touching the deck's own CSS/JS, which stay loaded and authoritative.

React + Vite + TypeScript app, deployable as static files plus one serverless function. It began as a PyQt6 desktop prototype (`QWebEngineView` + `QWebChannel`); that has been fully removed and replaced — there is no Python left. `docs/web-migration-plan.md` records the design rationale.

## Commands

```bash
npm install
npm run dev            # builds the editor bundle, then Vite dev server (http://localhost:5173)
npm run build          # editor bundle + tsc + production app build -> dist/
npm run typecheck      # tsc, no emit
npm run build:editor   # rebuild ONLY the injected editor bundle -> public/editor-bundle.js
```

There is no test suite yet.

**The editor-bundle gotcha (important):** the editor runs *inside the deck iframe*, so it is built as a separate IIFE (`vite.editor.config.ts` → `public/editor-bundle.js`) and injected at runtime. **Vite HMR does not cover it.** After editing anything under `src/editor/*` you must `npm run build:editor` (or restart `npm run dev`) to see the change. The app shell under `src/app/*` hot-reloads normally.

## The core invariant — one safe patch path

Both the Inspector panel and AI Edit converge on the same editor function, `applyPatch()` (`src/editor/core.ts`). The AI is never trusted to emit HTML/CSS/JS — only a small JSON patch with a fixed key set, sanitized **server-side and again client-side** before it reaches the DOM.

The patch contract lives in **one place**, `shared/`, imported by every consumer (this is the big structural win over the old PyQt code, where the key list was duplicated in three files):

- `shared/patch-keys.ts` — `PATCH_KEYS` + the `Patch` / `PatchKey` types (the single source of truth).
- `shared/validator.ts` — `validatePatch()`, the sanitization gate. Drops unsafe/unknown values silently; never throws.
- `shared/patch-schema.ts` — the OpenAI structured-output JSON schema, built from `PATCH_KEYS`.

The same principle now extends past single-object patches to a richer **action envelope** (`shared/actions.ts`) — `patch` | `layout` | `insertBlock` — so the AI can arrange objects and add content **without ever emitting HTML**. `validateActions()` is the gate; `editorApi.applyActions()` runs a whole batch under one undo snapshot. See `docs/ai-actions-plan.md` and the "AI actions" section below.

Adding or removing an editable property is a one-line change in `patch-keys.ts`; the validator, schema, and `applyPatch` all key off it. Keys: `text, x, y, w, h, fontSize, color, backgroundColor, borderColor, borderWidth, borderStyle, borderRadius, fontWeight, lineHeight, letterSpacing, opacity, zIndex, filter, src, backgroundImage, animationName, animationDuration, animationDelay, animationTimingFunction, animationIterationCount, animationPlayState`.

### Animations (preset library — Path A)

The AI/Inspector can animate objects, but only by **picking from a fixed menu**, never by authoring CSS/JS — so the trust model is unchanged. The menu lives in `shared/animation-presets.ts` (the curated 8: `fadeIn, fadeInUp, fadeInDown, slideInLeft, slideInRight, zoomIn, pulse, float`), which exports the preset name list (the enum), the timing-function enum, per-preset defaults, and the `@keyframes` CSS — imported by the validator (`safeAnimationName` is a strict whitelist), the JSON schema (`animationName`/`animationTimingFunction` are `enum`s), the editor, and the AI prompt. `applyPatchToElement` writes inline `animation-*` longhands referencing namespaced `@keyframes hpa-*`, restarts via a forced reflow so it replays on apply, and clears everything on `animationName:"none"`.

**Two load-bearing details:** (1) every preset's final keyframe is the neutral resting state (`transform:none; opacity:1`), so `animation-fill-mode:both` never leaves a deck element displaced — this is how preset animations respect the "never overwrite `transform`" invariant (CSS `animation` composes at the computed layer; it never writes the inline `transform`). (2) The keyframe library is injected lazily into the **deck** as `<style id="html-ppt-animations">` on first use — it carries neither the `data-html-ppt-editor` marker nor the editor-style id, so `getCleanHtml()` deliberately **keeps** it and exported decks stay self-contained; it lives in `<head>` so undo (slide-innerHTML only) doesn't drop it.

### AI actions — layout verbs + block library

Two capabilities that give the AI more power while keeping the "never emit HTML" harness (full rationale in `docs/ai-actions-plan.md`). Both flow through the **action envelope** (`shared/actions.ts`): the AI returns `{ message, actions[] }`, `validateActions()` sanitizes per `type` (dropping invalid, never throwing), and `editorApi.applyActions()` applies the whole batch under one undo snapshot. The OpenAI schema models an action as a **flat object** (`type` enum + every field nullable) rather than a discriminated `anyOf`, which is far more robust under strict structured output. `/api/ai-edit` returns this envelope; the bare `{patches}` shape is retired.

- **Layout verbs** (`align/distribute/stack/matchSize/grid/snapToGrid`): the AI emits a *verb + target ids only, never coordinates*. `applyLayoutInternal` reads live `localRect` geometry and applies `{x,y,w,h}` through `applyPatchToElement` — so it inherits `prepareForMove` ("never overwrite transform") and the validator's numeric clamps. `validateLayoutOp` enforces the verb/axis enums, intersects ids with the live selection, and requires per-verb minimum counts. The Toolbar's **Arrange** menu drives the same verbs manually (no AI; ids default to the live selection).
- **Block library** (`shared/blocks.ts`): the AI picks a `blockType` from the vetted 5 (`callout, statCard, bulletItem, quote, labelChip`) and fills **text slots** — it never authors markup. `insertBlockElement` clones the template and fills `[data-slot]` nodes via `setEditableText` (text nodes only). Blocks are self-contained; their base CSS rides the **same persisted-style seam** as animations (`<style id="html-ppt-blocks">`, kept by `getCleanHtml`). The Toolbar's **Block** menu inserts them manually.
- **Scene params** (`shared/scene-params.ts`): tune a deck's **3D / canvas background animation** (the part drawn by deck JS/WebGL that the editor can't touch as CSS). The AI emits a `sceneParam` action — a vetted `key` (`spinSpeed, particleOpacity, keyLightColor, fillLightColor, brightness`) + a clamped number / CSS-safe color — *never code*. A deck **opts in** by exposing `window.__htmlPptScene = { getParams(), setParam(key,value) }`; the editor only ever calls those two methods (`applySceneParamInternal`/`listSceneParams` in `core.ts`). The deck owns applying **and persisting** the change into a kept `<script id="html-ppt-scene">` (no editor marker → survives `getCleanHtml` export, re-applied on load). Decks without the controller report no params, so the Toolbar's **Scene** panel hides its 3D section and `sceneParam` actions no-op. Scene changes live in deck JS, so they're **outside the innerHTML undo stack**. The Tesla sample deck (`sample_deck/Sample_EnglishTeslaPPT/three_scene.js`) is the reference; the deck-author contract is documented in `docs/scene-params-contract.md`.
- **Universal CSS-animation control** (no deck contract): two complementary pieces handle ordinary CSS `@keyframes` motion on *any* deck. (1) The `animationPlayState` patch key (`running`|`paused`) pauses/resumes whatever animation is already on a **selected** element — deck-agnostic, alongside the existing `animationDuration` for retiming. (2) `listBackgroundMotion()`/`applyBackgroundMotion()` in `core.ts` power the Scene panel's **Motion (CSS layers)** group: a global Speed slider + Pause/Resume that scan the animated background layers and write inline `animation-duration` (scaled from the deck's *original* timing, remembered per element so changes never compound) and `animation-play-state`. Inline styles on body-level layers are kept by `getCleanHtml`, so speed/pause survive export (but, like scene params, aren't on the innerHTML undo stack).

## Architecture / data flow

```
                         ┌──────────────── React shell (parent document) ────────────────┐
 Toolbar ─┐              │  App.tsx  ──uses──> useEditorBridge(iframeRef)                 │
 Inspector ├─onPatch──>  │             │            │  postMessage Command {id,method,args}│
 AiDialog ─┘             │             │            ▼                                      │
   │ requestAiPatch      │      applyPatch(patch) ──┴──────────────┐                       │
   ▼                     └───────────────────────────────────────┼───────────────────────┘
 POST /api/ai-edit                                                │  (iframe boundary)
   │  (server holds OPENAI_API_KEY, runs validator)               ▼
   └─> safe patch ─> client re-validates ─> applyPatch     ┌─ deck <iframe> (srcdoc, same-origin) ─┐
                                                           │  injected editor bundle:              │
 events back to React  <──postMessage evt {selection|      │   src/editor/* (core, rpc, state)     │
 (selection/mutation/slide/log/ready)                      │   window.__htmlPptEditor = editorApi  │
                                                           └───────────────────────────────────────┘
```

- **`src/editor/`** — the editor itself (a TypeScript port of the original `editor_bridge.js`). Runs inside the iframe. `core.ts` holds all editing logic and the `editorApi` object; `rpc.ts` is the iframe side of the postMessage protocol; `events.ts` decouples emit from transport; `state.ts` holds `STATE` + the selector tables; `index.ts` is the IIFE entry that guards double-injection and sets `window.__htmlPptEditor`.
- **postMessage RPC replaces QWebChannel.** Parent → iframe sends `Command`s (`src/types/messages.ts`); methods that return values (`getCleanHtml`, `getSelectedContext`) resolve via a `Map<id, resolve>` in `useEditorBridge.ts`. iframe → parent sends fire-and-forget `EditorEvent`s (`selection`/`mutation`/`slide`/`log`/`ready`). srcdoc iframes are same-origin, so injection works and origins can be pinned.
- **`src/app/`** — the shell. `App.tsx` (orchestrator, ≈ the old `main_window.py`), `components/` (`DeckFrame` loads the deck + injects the bundle; `Toolbar` is a grouped icon bar; `Inspector` is a **floating panel** rendered only while something is selected — it auto-applies edits debounced 120ms and its × calls `bridge.deselect()`; `AiPromptDialog`; `ShortcutsHelp`), `hooks/` (`useEditorBridge` bridge client, `useKeyboardShortcuts`), `io/project-io.ts` (File System Access API), `ai/client.ts` (calls the proxy + re-validates).
- **`api/`** — the serverless AI proxy. `_handler.ts` holds the logic (reads `OPENAI_API_KEY`, calls the OpenAI Responses API with the shared schema, runs the validator, falls back to a deterministic **mock patch** if no key). `ai-edit.ts` is the web-standard edge wrapper. In dev, `vite.config.ts` mounts the same handler at `/api/ai-edit` so AI works with no separate backend.

## Editor hard constraints (preserve when editing `src/editor/`)

These behaviors are load-bearing — the original deck animations and DOM integrity depend on them:

- **Never reparent elements and never overwrite `transform`.** Decks animate via `.anim` opacity/transform transitions and `.slide.in-view`. `prepareForMove()` only sets `position:relative` (if static) + `left`/`top`/`zIndex`; movement adjusts `left`/`top`, never `transform`.
- **Selection must not mutate the DOM.** A plain click only highlights; `prepareForMove` runs lazily on the first >5px drag.
- **Text editing rewrites text *nodes*, not `innerHTML`.** `setEditableText` walks `TreeWalker(SHOW_TEXT)` and maps newline-separated lines onto existing text nodes, preserving nested `<strong>/<span>/<cite>`. `textSafe` in the payload signals whether text editing is offered.
- **Two-tier selection targeting** (`normalizeTarget`): prefer known deck classes in `BLOCK_SELECTOR`, else fall back to `isGenericEditableObject` heuristics; `NEVER_SELECT_SELECTOR` blocks structural chrome (clicking the Three.js canvas selects `#three-canvas-container`).
- **Viewport-based slide tracking** via `IntersectionObserver` + `bestVisibleSlide()`, expecting `.slide` inside `.presentation`; re-entering a slide replays its animation by toggling `.in-view`.
- **Edit Mode OFF is a clean presentation view**: `setEditMode(false)` clears selection, handle, the orange dashed `data-html-ppt-live-edit` outline, contenteditable, and drag/resize state.
- **`getCleanHtml()`** clones the DOM and strips every editor artifact (`[data-html-ppt-editor]`, the injected style, `contenteditable`, `data-html-ppt-*`) before save/export.

## Keyboard shortcuts & undo/redo

PowerPoint-style shortcuts: Ctrl/⌘ Z/Y (undo/redo), C/X/V (copy/cut/paste via an internal clipboard in `STATE.clipboard`), D (duplicate), Delete/Backspace, arrow nudge (Shift = 10px), Ctrl ] / [ (z-order), Esc (deselect/finish text).

**They are handled in two places, by design** — and must stay in sync:
- `src/editor/core.ts` `onKeyDown` handles events when focus is inside the deck iframe.
- `src/app/hooks/useKeyboardShortcuts.ts` handles them when focus is in the React shell, forwarding to `editorApi` via the bridge.
The two never double-fire (separate documents), but adding a shortcut means adding it to *both*. The parent hook ignores events while a form field is focused.

**Undo/redo** (`src/editor/history.ts`) is snapshot-based: `saveState()` pushes the slide container's `innerHTML` before each discrete mutation (drag/resize gesture start, applyPatch, insert, duplicate, delete, z-order, text-edit start, paste; arrow nudges are coalesced). It emits a `history` event (`{canUndo,canRedo}`) that drives the toolbar buttons. Caveat: restoring `innerHTML` re-creates nodes, so deck-attached listeners inside a slide (e.g. a Three.js canvas) are dropped on undo of that slide.

## Deck loading & save/export (`io/project-io.ts`)

- **Open Folder** (Chromium): File System Access API; enables *Save HTML* in place and *Export Project*. **Open Files…**: `<input webkitdirectory>` fallback (any browser); save falls back to download.
- The deck is rendered via a same-origin `srcdoc` iframe with assets rewritten to blob URLs. **Known limitation:** only `src`/`href` attributes are rewritten — CSS `url(...)` references inside stylesheets are not yet, so relative font/image refs in a deck's CSS may not resolve in preview.
- *Save HTML*, *Export HTML Only*, and *Export Project* all read the live DOM via the bridge's `getCleanHtml()`.

## Conventions

- Korean is a first-class UI language for AI prompts; the mock-mode keyword matching in `api/_handler.ts` is bilingual (고급/premium, 크게/bigger, 가운데/center). Don't strip the Korean keywords.
- `validatePatch` is the trust boundary for untrusted (AI) data — keep new patch handling routed through it, and prefer dropping bad values to throwing.
- The editor only ever writes inline `style="..."` (and text nodes) onto deck elements; it never edits the deck's CSS/JS files.
- `sample_deck/` is a sample HTML deck kept as test content — load it via Open Folder.
