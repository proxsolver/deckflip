# AI Actions: Layout Verbs + Block Library

Status: implemented (Tier 1 + Tier 2). Records the design rationale, in the
spirit of `web-migration-plan.md`.

## Goal

Give the AI (and the Inspector/Toolbar) more power **without** ever letting it
emit HTML/CSS/JS. The trust model is unchanged from the patch pipeline: the AI
chooses from a fixed, validated vocabulary; the editor does all DOM/geometry
work. New capabilities:

1. **Layout verbs** — align / distribute / stack / matchSize / grid / snapToGrid
   over the current multi-selection. The AI emits a *verb + target ids only,
   never coordinates*; the editor reads live geometry and computes the pixels.
2. **Block library** — insert vetted, self-contained content blocks (callout,
   stat card, bullet, quote, label chip). The AI picks a `blockType` and fills
   **text slots**; the template markup ships with the app and is filled via the
   text-node discipline, so the AI can never inject a tag/class/attribute.

## The unifying structure: an action envelope

`shared/actions.ts` defines a discriminated `EditorAction`:

- `{ type:"patch", id, patch }` — the existing sanitized patch.
- `{ type:"layout", op, axis?, ids, relativeTo?, gap?, cols?, step? }`
- `{ type:"insertBlock", blockType, slots:[{name,value}], target? }`

The AI returns `{ message, actions: EditorAction[] }`. One server validator
(`validateActions`) dispatches per `type`, dropping invalid entries and never
throwing (same contract as `validatePatch`). One editor entry
(`editorApi.applyActions`) runs the whole batch under **a single `saveState()`
snapshot and one `emitMutation()`**, so a multi-step AI response is one undo
step. The bare `{ patches: [...] }` shape stays accepted for back-compat.

To stay robust against OpenAI strict-mode `anyOf` quirks, the JSON schema models
an action as a **flat object** (`type` enum + every field nullable); the
validator interprets fields by `type`.

## Layout verbs — harness

- AI emits no geometry. The editor resolves ids → elements, reads `localRect`
  (slide-relative), computes targets, and applies via `applyPatchToElement`
  `{x,y,w,h}` — so it inherits `prepareForMove` ("never overwrite transform")
  and the validator's numeric clamps. Worst case is an arrangement you undo.
- `validateLayoutOp` checks `op`/`axis` enums, intersects `ids` with the live
  selection, enforces per-verb minimum counts (distribute ≥3, stack/matchSize
  ≥2, align/grid/snap ≥1), clamps `gap/cols/step`.
- Toolbar exposes the verbs manually (no AI): align L/C/R, top/middle/bottom,
  distribute H/V — enabled at `selectionCount ≥ 2`.

## Block library — harness

- `shared/blocks.ts` holds the library: per-type `html` template with
  `data-slot="name"` markers, slot specs (`maxLength`, default), `defaultSize`,
  and `BLOCK_BASE_CSS`.
- Blocks are **self-contained** (v1): they ship their own neutral styling, so
  they look consistent in any deck and can't break the format. Mapping blocks
  onto a deck's *own* classes is a follow-up that needs the design-system
  extractor.
- Base styling is injected via the **persisted-style seam** reused from the
  animation feature: `<style id="html-ppt-blocks">` in `<head>`, kept by
  `getCleanHtml()`, so exported decks stay self-contained. (This also avoids the
  latent gap where `.html-ppt-created-*` base CSS lives in the *stripped* editor
  stylesheet.)
- `insertBlock` parses the template, fills `[data-slot]` nodes with
  `setEditableText` (text nodes only), positions into the target slide, selects
  it, snapshots once.
- `validateBlockSpec` whitelists `blockType`, keeps only that type's known slot
  names, coerces each value to text and caps length, clamps `target`.

## Files

New: `shared/actions.ts`, `shared/blocks.ts`.
Edited (shared): `validator.ts`, `patch-schema.ts`.
Edited (editor): `src/editor/core.ts`, `src/types/messages.ts`.
Edited (shell): `src/app/ai/client.ts`, `src/app/App.tsx`,
`src/app/components/Toolbar.tsx`, `src/app/theme/theme.css`.
Edited (api): `api/_handler.ts`.
