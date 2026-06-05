// Scoped element regeneration — the AI rebuilds the inner HTML of ONE selected
// element "from scratch" (advanced restyle/restructure beyond the patch
// vocabulary). This deliberately EMITS HTML, the controlled exception to the
// "edits never emit HTML" invariant: it is scoped to a single node, sanitized
// HERE (authoritative) and again in the editor, and applied under one undo
// snapshot. Reuses the generation provider layer (Anthropic Opus → OpenAI) for
// quality; no key → a deterministic mock so the flow works secret-free.

import { sanitizeHtml, type ElementRegenRequest, type ElementRegenResponse } from "../../shared/editing";
import { resolveProviders, callWithFallback, env, type Providers } from "../_generation/providers";

const ELEMENT_SYSTEM = `You rebuild the INNER HTML of a single element inside an existing HTML presentation slide. You are given the element's current outerHTML, its slide context, and the deck's design brief.

HARD RULES:
- Return ONLY the new INNER HTML for that element (its children) — NOT the element's own opening/closing tag, NOT a full document.
- Never output <script>, <style>, <iframe>, <form>, inline event handlers (onclick=…), or javascript: URLs. Plain presentational HTML only: headings, paragraphs, lists, spans, figures, images, tables, blockquotes.
- Keep it consistent with the deck's palette, fonts, and voice (from the brief). You MAY use inline style="…" for visual polish, and reuse class names you see in the context.
- Preserve any <img> the element already had unless the user asks otherwise (keep its src exactly).
- Keep the content on a single slide — do not produce overflowing amounts of content.
- Honor the user's instruction. Make a genuine, tasteful redesign, not a trivial tweak.
Always answer by calling the emit_element tool.`;

const EMIT_ELEMENT_SCHEMA = {
  type: "object",
  properties: {
    html: { type: "string", description: "The new inner HTML for the element (children only, no outer tag, no <html>/<script>/<style>)." },
    message: { type: "string", description: "One short sentence describing the change." },
  },
  required: ["html", "message"],
  additionalProperties: false,
} as const;

export async function handleAiEditElement(req: ElementRegenRequest): Promise<ElementRegenResponse> {
  const prompt = (req?.prompt ?? "").trim();
  if (!prompt) throw new Error("Describe how to rebuild the element.");
  const ctx = req?.context;
  if (!ctx || typeof ctx.id !== "string" || !ctx.id) throw new Error("No selected element context was provided.");

  const forceMock = /^(1|true|yes|on)$/i.test(env("HTML_PPT_AI_MOCK") || "");
  const log: Record<string, unknown> = {};
  const providers: Providers = forceMock ? { primary: undefined, fallback: undefined } : resolveProviders(log);

  if (!providers.primary) {
    return mockElement(prompt, ctx);
  }

  const userText =
    `=== 사용자 요청 ===\n${prompt}\n\n` +
    `=== 이 요소의 현재 outerHTML (이 요소의 INNER HTML만 새로 작성) ===\n${String(ctx.outerHTML ?? "").slice(0, 6000)}\n\n` +
    `=== 슬라이드 컨텍스트 ===\nslideClass: ${ctx.slideClass ?? ""}\ninlineStyle: ${ctx.inlineStyle ?? ""}\n\n` +
    `=== designBrief ===\n${req.deckBrief ? JSON.stringify(req.deckBrief, null, 2) : "(none)"}`;

  try {
    const res = await callWithFallback(
      providers,
      {
        maxTokens: Number(env("HTML_PPT_ELEMENT_MAX_TOKENS") || "6000"),
        images: [],
        userText,
        schema: EMIT_ELEMENT_SCHEMA,
        toolName: "emit_element",
        toolDescription: "Return the new inner HTML for the element plus a one-line message.",
        system: ELEMENT_SYSTEM,
      },
      log,
      "element"
    );
    const out = (res.input && typeof res.input === "object" ? res.input : {}) as Record<string, unknown>;
    const rawHtml = typeof out.html === "string" ? out.html : "";
    const html = sanitizeHtml(rawHtml);
    if (!html.trim()) throw new Error("Element regeneration returned empty content after sanitization.");
    const message = typeof out.message === "string" && out.message ? out.message : "Rebuilt the element.";
    return { html, message, mock: false };
  } catch (err) {
    console.error("[ai-edit-element] failed:", String((err as Error)?.message ?? err));
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// Offline demo: wrap the element's existing text in a tasteful card-ish layout so
// the round-trip is visible without a key.
function mockElement(prompt: string, ctx: ElementRegenRequest["context"]): ElementRegenResponse {
  const text = String(ctx.innerText ?? "").trim().slice(0, 240) || "Rebuilt content";
  const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
  const html = sanitizeHtml(
    `<div style="display:flex;flex-direction:column;gap:10px;padding:18px;border:1px solid currentColor;border-radius:14px">` +
      `<span style="font-size:.7em;letter-spacing:.18em;text-transform:uppercase;opacity:.7">Rebuilt</span>` +
      `<div style="font-weight:600;line-height:1.3">${esc(text)}</div>` +
      `</div>`
  );
  return { html, message: `Demo mode — rebuilt the element (set ANTHROPIC_API_KEY/OPENAI_API_KEY for real AI). Asked: "${prompt.slice(0, 60)}"`, mock: true };
}
