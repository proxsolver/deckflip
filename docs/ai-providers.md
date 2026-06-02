# User-selectable AI provider (OpenAI / Anthropic / Google)

Status: planned (user is implementing). Build reference.

## Principle

The provider is just a different *source* of a proposal that still has to survive
`validateActions()` before it touches the DOM. Adding providers does NOT widen
the attack surface — the validator stays the single gate. Everything here is
plumbing + per-provider transport around that fact.

## Server: provider adapter registry

Refactor `api/_handler.ts` so prompt-building is provider-agnostic:
- Extract `buildActionPrompt(prompt, contexts) → { system, user }` (the current
  `callOpenAi` prompt assembly).
- Adapter interface (new `api/providers.ts`, server-only — holds fetch + keys):

```ts
interface ProviderAdapter {
  id: "openai" | "anthropic" | "google";
  label: string;
  supportsImages: boolean;
  isConfigured(): boolean;                 // its API key present in env
  generateActions(a: { system: string; user: object; timeoutMs: number }): Promise<unknown>;
}
```

`handleAiEdit`: pick adapter → `generateActions(...)` → `validateActions(raw, ids)` (unchanged).

### Transports / structured-output mechanism

- OpenAI — Responses `/responses`, `text.format={type:"json_schema",strict:true,schema}`; parse `output_text`.
- Anthropic — Messages `/v1/messages` (`x-api-key`, `anthropic-version`), forced
  tool use: `tools:[{name:"emit_actions",input_schema}]`,
  `tool_choice:{type:"tool",name:"emit_actions"}`; read the `tool_use` block's
  `.input` (ALREADY a parsed object — no JSON.parse).
- Google — `…/models/{model}:generateContent?key=`,
  `generationConfig:{responseMimeType:"application/json",responseSchema}`; parse
  `candidates[0].content.parts[0].text`.

## Schema translation (the one real work item)

`ACTION_ENVELOPE_SCHEMA` is OpenAI-flavored (nullable unions `type:["string","null"]`,
all-fields-required, `additionalProperties:false`).
- OpenAI: as-is.
- Anthropic: `input_schema` is standard JSON Schema → drop-in / near-drop-in.
- Google: Gemini `responseSchema` is an OpenAPI subset — NO union `type` arrays
  (`{type:"string",nullable:true}` instead), NO `additionalProperties`, enums on
  string type only. Add a pure `toGeminiSchema(schema)` in `shared/patch-schema.ts`.
- Net: even if a provider imperfectly honors the schema, `validateActions` drops
  the slop — quality/retry concern, not a security one.

## Configuration & security

- Keys never leave the server. The request carries only a provider `id`, never a
  key / model string / URL.
- Allowlist the id against `PROVIDERS` AND require it be configured.
- Model + base URL stay env-controlled per provider (`HTML_PPT_ANTHROPIC_MODEL`,
  `HTML_PPT_GEMINI_MODEL`, existing `HTML_PPT_AI_MODEL`). User picks a provider,
  not an arbitrary model (closes cost-abuse / SSRF).
- Env: existing `OPENAI_API_KEY`; new `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`;
  `HTML_PPT_AI_PROVIDER` = default id; existing `HTML_PPT_AI_MOCK` still forces demo.
- Capability discovery: `GET /api/ai-providers` →
  `{ providers:[{id,label,configured,supportsImages}], default }` — BOOLEANS ONLY,
  never keys. UI shows only configured providers; none → Demo mode (current path).

## Contract + UI

- `AiEditRequest` gains optional `provider`. Absent/invalid → `HTML_PPT_AI_PROVIDER`
  or first configured.
- Client: `requestAiActions(prompt, contexts, provider?)`, `requestAiImage(…, provider?)`,
  new `fetchProviders()`.
- `AiChat` header gets a provider dropdown (session-level); threads through
  `runAi(prompt,{image,provider})`.

## Image generation (v1 scope)

Text edits multi-provider; image generation stays OpenAI-only (`gpt-image-1`).
Hide/lock the picker to image-capable providers in image mode.

## Files

New: `shared/providers.ts`, `api/providers.ts`, `api/ai-providers.ts`,
`toGeminiSchema()` in `shared/patch-schema.ts`.
Edited: `api/_handler.ts`, `vite.config.ts` (dev `GET /api/ai-providers` + a
`jsonGet` helper), `src/app/ai/client.ts`, `src/app/components/AiChat.tsx`,
`src/app/App.tsx`, `CLAUDE.md`.

## Locked decisions

1. OpenAI + Anthropic first; Google third behind the registry once `toGeminiSchema` lands.
2. A named-but-unconfigured provider → hard, clear error (not silent fallback).
3. Images OpenAI-only in v1.

## Gotchas (from the codebase)

- **Dev server binds the handler at startup.** `vite.config.ts` imports
  `handleAiEdit`/`handleAiImage` in `configureServer`, so editing `api/_handler.ts`
  or `api/providers.ts` needs a **`npm run dev` restart** (not HMR). App/AiChat/
  client changes hot-reload normally.
- **Anthropic returns the object pre-parsed** in the `tool_use` block's `.input`;
  OpenAI/Gemini return text you must `JSON.parse`. Easy to mishandle uniformly.
- **Keep every provider's output routed through `validateActions`** — no provider
  "fast path" that bypasses the gate.
- `/api/ai-providers` must be added to BOTH `vite.config.ts` (dev, as a GET) and a
  prod `api/ai-providers.ts` edge wrapper.
