<div align="center">

# 🪄 DeckFlip

**Generate a presentation from a topic with AI, then refine it by clicking, dragging, and re-prompting — all in the browser.**

DeckFlip does two things end-to-end: it **creates** a self-contained HTML/CSS/JS deck from a topic, and it lets you **edit** that deck live — recolor, move, restyle, animate, or just ask the AI — **without ever touching the markup, and without breaking the deck's own styles, scripts, or animations.**

![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646cff?logo=vite&logoColor=white)
![AI-safe](https://img.shields.io/badge/edits-never%20emit%20HTML-brightgreen)

<!-- Overview: the editor working on a live AI-generated deck — title selected, inspector open. -->
![DeckFlip overview](docs/overview.png)

</div>

---

## See it in action

The deck on the left is a complete, self-contained HTML presentation an AI wrote — gradients, a live Three.js background, scroll-triggered animations and all. DeckFlip renders it **live** and lets you edit it like PowerPoint: select the title, nudge it, recolor it, or just ask the AI to "make it more premium" — and the deck's own code keeps running untouched.

![DeckFlip demo](docs/slidesmith-demo.gif)

> ▶️ This is a short, looping highlight. **[Watch the full demo in HD (MP4, 2.4 MB)](docs/slidesmith-demo.mp4)** for the complete walkthrough.

---

## Architecture at a glance

DeckFlip is a **React + Vite + TypeScript** app deployable as static files plus a small set of serverless functions. It splits cleanly into a **frontend** (the browser app) and a **backend** (the serverless AI functions + the generated-deck storage).

```
┌──────────────────────────── FRONTEND (browser) ───────────────────────────┐
│                                                                            │
│   React shell (src/app)                                                    │
│   ├── 1. AI GENERATION  — "New — AI Deck" wizard creates a deck from a topic│
│   └── 2. AI MODIFICATION — live editor refines an open deck (mouse + AI)    │
│                                                                            │
│   Deck renders in a sandboxed same-origin <iframe>; an injected editor      │
│   bundle (src/editor) is the only thing that mutates the deck DOM.          │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                   │  HTTP (fetch)
┌─────────────────────────────────▼──────────────────────── BACKEND ─────────┐
│   Serverless functions (api/)                                               │
│   ├── api/_generation/  — multi-pass deck generation pipeline               │
│   └── api/_editing/     — single-patch / action / element-regen edits       │
│                                                                            │
│   Generated decks + every prompt are written to  generated/<deckId>/        │
│   (the stand-in "database" until a real backend exists)                     │
│                                                                            │
│   Contracts shared by both sides live in  shared/  (the trust boundary)     │
└────────────────────────────────────────────────────────────────────────────┘
```

The **`shared/`** tree is the single source of truth imported by *both* the frontend and the backend, so the contracts can never drift across consumers:

- **`shared/editing/`** — the edit vocabulary: patch keys, the JSON schema, the `validatePatch` / `validateActions` gate, animation presets, content blocks, scene params, HTML sanitizer.
- **`shared/generation/`** — the generation contract: request/deck/brief/plan types, the multi-pass output schemas, the wizard menus, token/cost pricing.

---

## Frontend

The browser app (`src/app`) has two distinct AI capabilities, plus the editor engine that runs inside the deck iframe (`src/editor`).

### 1 · AI generation — creating a deck from a topic

File ▸ **"New — AI Deck"** (sparkle icon) opens a wizard — **Topic → Persona → Format → Sample → Details → Review** (`src/app/components/NewDeckWizard.tsx`). It collects what the deck should look like and be about, POSTs it to the backend, and **auto-loads the returned deck** straight into the editor for refinement.

- **Persona** — the biggest driver of look: a taste picker + short conversational Q&A + optional reference-image uploads (vision-only style cues). Persisted reusably in `localStorage`.
- **Format** — `interactive | presentation | document` + a visual preset.
- **Sample** — 3 one-slide HTML candidates; the picked one **locks** the full deck's palette/fonts/preset.
- **Details** — title, detail text, and source files (pdf/docx/txt/images) parsed server-side into text + extracted images that the slides can place.

Generating a *new* deck legitimately emits full HTML/CSS/JS — that is the one place markup is authored, and it happens on the **backend**. The generated deck renders in the same sandboxed iframe as any user-opened deck, so it doesn't widen the editor's trust boundary.

Client entry: `src/app/ai/generate-client.ts` → `requestGeneration()` → `buildDeckFromContents()` (`io/project-io.ts`).

### 2 · AI modification — editing an open deck

Once a deck is open, every edit flows through **one safe path** and comes out as a small, **validated JSON patch / action** — never markup.

> **The AI never emits HTML, CSS, or JS when editing. Ever.**

- 🎯 **Direct manipulation** — click to select, drag to move, handle to resize, double-click to edit text. Works on arbitrary AI-generated boxes/cards/titles.
- 🤖 **AI Edit (chat)** — select an object, describe a change in English **or** Korean, get a validated patch applied live. Multi-turn chat to keep refining.
- 🧱 **AI actions, still no HTML** — the AI can **arrange** objects (align / distribute / stack / grid / snap) and **insert vetted content blocks** (callout, stat card, bullet, quote, label chip) by naming verbs and filling text slots.
- 🎞️ **Animation presets** — curated entrance/emphasis animations (`fadeIn`, `fadeInUp`, `slideInLeft`, `zoomIn`, `pulse`, `float`, …) from a fixed menu; each rests at a neutral final frame so it never displaces a deck element.
- 🌌 **Scene & motion control** — tune a deck's 3D / canvas background (spin speed, light colors, brightness) and globally pause/retime CSS background animations.
- ✨ **Scoped element regeneration** — the one *controlled* exception: the AI rebuilds the inner HTML of **one selected element**, triple-sanitized server- and client-side before it reaches the DOM.

Every edit is validated **server-side and again client-side** before a single value reaches the DOM. Unknown keys, unsafe values, and anything off-contract are silently dropped — the gate never throws, it just refuses. The worst a bad AI response can do is produce *no* change.

**Why the deck never breaks** (load-bearing invariants in `src/editor/`):

- **Never reparents elements, never overwrites `transform`** — moving an object only adjusts `left`/`top`, so scroll animations and 3D scenes keep working.
- **Text edits rewrite text *nodes*, not `innerHTML`** — editing a heading preserves nested `<strong>`, `<span>`, `<cite>`.
- **Selection is non-destructive** — a click only highlights; the DOM isn't mutated until you actually drag.
- **The deck's CSS/JS stay authoritative** — the editor only ever writes inline `style="…"` (and text).
- **Exports are clean** — `getCleanHtml()` strips every editor artifact, so a saved deck is byte-for-byte a normal presentation again.

### How the frontend pieces talk

The deck renders inside an isolated **same-origin `<iframe>`**, and a small editor bundle (`src/editor/*`, built as a standalone IIFE) is injected into it. The React shell talks to the editor over `postMessage`.

```
React shell ──postMessage──▶ editor (in iframe)  ── mutates deck DOM (inline styles + text nodes only)
     │                                  ▲
     └─ AI chat ─▶ /api/ai-edit ─▶ model ─▶ validate ─▶ safe {patch | layout | insertBlock} ─┘
```

> The editor runs **inside the deck iframe**, so Vite HMR doesn't cover it. After changing anything in `src/editor/*` you must rebuild it: `npm run build:editor`. The shell under `src/app/*` hot-reloads normally.

---

## Backend

The backend is a set of **serverless functions** under `api/`. Route files live at `api/` root (their paths map to URLs); the logic lives in `_`-prefixed folders, split by domain.

### Generation functions — `api/_generation/`

A multi-pass editorial pipeline that turns a wizard request into a polished, self-contained deck:

1. **`emit_plan`** — a `DesignBrief` + slide-by-slide outline (optionally web-searched for real stats/brand colors).
2. **`emit_foundation`** — `style.css`, `script.js`, optional `three_scene.js`, and a component manifest.
3. **`emit_slides`** — per-section `<section class="slide">` markup, parallelized by chunk.
4. **assemble** — the server deterministically builds `index.html`, wires charts, and lint-checks the result.
5. **`emit_qa_fixes`** — lint-gated prompt-only repair.

Provider: prefers **Anthropic Opus**, auto-falls back to **OpenAI**, and finally to a deterministic **mock deck** so generation never hard-fails. Supporting routes: `parse-upload` (file → text+images), `generate-candidates` (sample slides), `persona-interview`, `regenerate-scene` (author a new `three_scene.js`).

### Editing functions — `api/_editing/`

Holds the API key and runs the validator before returning anything:

- **`/api/ai-edit`** — returns the sanitized action envelope (`patch | layout | insertBlock | …`).
- **`/api/ai-edit-element`** — scoped element regeneration (HTML allowlisted server-side).
- **`/api/ai-image`**, **`/api/ai-image-search`** — image generation + stock-photo search.

With **no API key**, both flows fall back to deterministic mocks, so the entire app works **secret-free**. In dev, `vite.config.ts` mounts these handlers in-process, so **AI works with no separate backend**.

### Storage — how generated files & prompts are saved

The backend persists each generated deck to disk under **`generated/<deckId>/`** — the stand-in "database" until a real backend exists (swapping one module, `api/_generation/storage.ts`, replaces it). Because it uses `node:fs`, the generation routes need a **Node** runtime.

```
generated/<deckId>/
├── index.html        # the assembled deck (the 4 deck files…)
├── style.css
├── script.js
├── three_scene.js    # only when the deck uses a 3D background
├── assets/           # extracted/uploaded images, referenced as assets/<name>
│   └── img-N.ext
├── _request.json     # verbatim user wizard input
├── _plan.json        # the multi-pass outline (debug trail)
├── _brief.json       # the compact DesignBrief (palette/fonts/voice — reused on every later edit)
├── _prompts.json     # DURABLE PROMPT HISTORY — every generation pass prompt AND
│                     #   every later modification prompt (edit / scene-regen / element-regen)
└── _log.json         # token usage, stage, duration, errors (maintenance trail)
```

- **`_prompts.json` is the durable prompt log.** Every generation pass's prompt is written at creation; every later *modification* prompt is appended (the client POSTs each edit prompt to `/api/deck-prompts` → `appendPrompt`). This keeps the full prompt history of a deck server-side.
- **`_brief.json`** is threaded into every AI edit so the editing model remembers the deck's original palette/fonts/voice — keeping the "session alive" across edits without resending the transcript.
- The browser's `localStorage` (`slidesmith.*`) is just the fast UI mirror (chat threads, last deck for session restore); the `generated/` folder is the authoritative copy.
- Generation never fails on a write error (it's logged; the deck is still returned). `generated/` is gitignored.

### Adding a new API endpoint

Every endpoint follows the same three-part recipe: **logic** in a `_`-prefixed folder, a **thin route wrapper** at `api/` root, and a **dev mount** in `vite.config.ts`. The split exists because Vercel routes by filename — files under `api/_*/` are ignored for routing, so all reusable logic lives there and the route files just adapt the request.

**1 · Write the handler** (the actual work) in the matching domain folder — `api/_editing/` for edits, `api/_generation/` for generation. A handler takes the parsed JSON body and returns a plain object:

```ts
// api/_generation/my-thing.ts
import { env } from "../_editing/common";   // env("MY_API_KEY") — server-only secrets

export interface MyThingRequest { topic: string }

export async function handleMyThing(body: MyThingRequest): Promise<{ result: string }> {
  const key = env("MY_API_KEY");            // undefined → fall back to a mock (keep the app secret-free)
  // …do the work…
  return { result: "…" };
}
```

**2 · Add the route wrapper** at `api/` root (the filename *is* the URL: `api/my-thing.ts` → `/api/my-thing`). Copy an existing one — they're identical except the import:

```ts
// api/my-thing.ts
import { handleMyThing } from "./_generation/my-thing";

// export const config = { runtime: "edge" };   // edge-safe handlers only; OMIT if it uses node:fs

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  try {
    const result = await handleMyThing(await request.json());
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), { status: 400 });
  }
}
```

> **Runtime choice:** if the handler touches `node:fs` or anything Node-only (e.g. it reads/writes `generated/`, or uses `mammoth`/`pdfjs-dist`), it needs the **Node** runtime — *omit* the `config.runtime = "edge"` line. Pure fetch-based handlers can stay on edge.

**3 · Mount it in dev** so `npm run dev` serves it without a separate backend — add one line to the `aiDevApi()` plugin in `vite.config.ts` (and import the handler at the top):

```ts
jsonPost(server, "/api/my-thing", (p) => handleMyThing(p as Parameters<typeof handleMyThing>[0]));
```

> The dev middleware imports handlers at startup, so **restart `npm run dev`** after adding or editing one.

**4 · Call it from the frontend** — add a typed wrapper to `src/app/ai/` (`client.ts` for edits, `generate-client.ts` for generation), following the existing `fetch("/api/…")` pattern:

```ts
export async function requestMyThing(topic: string): Promise<string> {
  const resp = await fetch("/api/my-thing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic }),
  });
  if (!resp.ok) throw new Error(`my-thing failed: ${resp.status}`);
  return (await resp.json()).result;
}
```

**5 · Put any request/response types in `shared/`** (`shared/editing/` or `shared/generation/`) if both the handler and the client need them — that keeps the contract in one place, the way every other endpoint does. Register any new env vars in [`.env.example`](.env.example).

---

## Quick start

Requires **Node.js 18+**. For folder loading and save-in-place, use a **Chromium browser** (Chrome/Edge).

```bash
npm install
npm run dev          # builds the editor bundle, then starts Vite (http://localhost:5173)
```

`npm run dev` also serves the AI endpoints in-process, so **both generation and editing work in dev with no separate backend** (mock mode until you add a key).

## Usage

1. **Create with AI** — File ▸ *New — AI Deck*, walk the wizard, and the generated deck auto-loads. *(Or load an existing deck: Open Folder on Chromium, or Open Files… anywhere. Samples are in [`sample_deck/`](sample_deck).)*
2. **Edit** — with **Edit ON**, click an object; the floating inspector appears for position/size/text/colors. Drag to move, corner handle to resize, double-click to edit text.
3. **AI Edit** — select an object, click **AI**, and chat your request (e.g. *"make the title bigger"*, *"warm beige background, gold border"*, *"이 박스를 더 고급스럽게"*).
4. **Save / Export** — File menu: *Save HTML* (in place), *Export HTML Only*, *Export Project* (full folder), or *Download AI source files*.

### Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Undo / Redo | `Ctrl/⌘ Z` / `Ctrl/⌘ Y` (or `Ctrl/⌘ Shift Z`) |
| Copy / Cut / Paste | `Ctrl/⌘ C` / `X` / `V` |
| Duplicate | `Ctrl/⌘ D` |
| Delete | `Delete` / `Backspace` |
| Nudge selected (×10 with Shift) | Arrow keys |
| Bring to front / Send to back | `Ctrl/⌘ ]` / `Ctrl/⌘ [` |
| Next / previous slide | `Page Down` · `Space` / `Page Up` |
| Edit text / finish | Double-click / `Esc` |

(There's a **?** button in the toolbar with the full list.)

## AI setup

By default the app runs in **mock mode** (no key required). To use real models, copy [`.env.example`](.env.example) to `.env` and fill in a key, then restart `npm run dev`. Keys are read **server-side only** — never shipped to the browser.

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables real generation (preferred provider, Opus). |
| `OPENAI_API_KEY` | Used for AI edits, and as the generation fallback. |
| `HTML_PPT_GEN_MODE` | `multi` (default, chunked & assembled) or `single` (one bespoke call). |
| `HTML_PPT_GEN_PROVIDER` | Flip provider preference (`anthropic` \| `openai`). |
| `HTML_PPT_WEB_SEARCH` | Live web research in the plan pass (default on). |
| `HTML_PPT_AI_MOCK` | Force mock mode even with a key set. |
| `UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY` | Stock-photo search for "find & paste a real photo". |

See [`.env.example`](.env.example) for the full, commented list (per-pass token limits, QA mode, timeouts, etc.).

## Project structure

```
shared/
  editing/      single source of truth for EDITS — patch keys, schema, validator, actions, animations, blocks, scene params
  generation/   single source of truth for GENERATION — request/deck/plan types, multi-pass schemas, wizard menus, pricing

src/
  editor/       the editor injected into the deck iframe (standalone IIFE) — selection, drag/resize, text nodes, animation, scene
  app/          the React shell — App orchestrator, Toolbar, Inspector, DeckFrame, AiChat, NewDeckWizard, hooks, io, ai clients
  types/        postMessage protocol + selection/context types

api/
  _generation/  deck generation pipeline (plan→foundation→slides→assemble→QA), providers, parsing, storage
  _editing/     edit endpoints (patch/action, element regen, images) + validator gate
  *.ts          thin route wrappers mapping to /api/* URLs

generated/      backend storage — one folder per deck (deck files + assets + prompt/brief/log JSON); gitignored
sample_deck/    example AI-generated decks to try
docs/           architecture notes, the generation pipeline spec, demo media
```

## Build & deploy

```bash
npm run build      # editor bundle + type-check + production build → dist/
npm run typecheck  # tsc, no emit
npm run build:editor   # rebuild ONLY the injected editor bundle → public/editor-bundle.js
```

- **App**: host `dist/` as static files anywhere.
- **AI functions**: deploy `api/*.ts`. The generation/parse/persona/candidates/deck-prompts routes use `node:fs`, so they need a **Node** runtime (not edge); the edit/image routes target edge runtimes.

## Known limitations

- CSS `url(...)` references inside a deck's stylesheets aren't yet rewritten to blob URLs (only `src`/`href` attributes are), so relative font/image refs in CSS may not resolve in the preview.
- *Save HTML* in place needs a folder opened via the directory picker (a browser permission grant); decks opened via file upload download instead.
- Visual QA / PDF export (a headless-browser pass) is deferred — QA is currently prompt-only.

## License

**Proprietary — All rights reserved.** © 2026 Jaewoong Hwang. This source is
made visible for reference only; no use, copying, modification, or distribution
is permitted without written permission. See [`LICENSE`](LICENSE). For licensing
inquiries, contact the owner.
