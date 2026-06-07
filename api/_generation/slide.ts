// Server-side SINGLE-SLIDE generator. Authors ONE new <section class="slide"> to
// be inserted between existing slides (Phase 3 slide management). This is
// GENERATION (it emits HTML), like scene regen / initial generation, and renders
// in the same sandboxed srcdoc iframe — so it does NOT go through validateActions.
// The editor additionally sanitizes the html (sanitizeHtml + scrubSubtree) before
// it touches the live DOM, because the slide lands in a deck the user already trusts.
//
// Reuses the provider abstraction (Anthropic Opus primary, OpenAI fallback). No key
// → a deterministic mock slide so the flow works secret-free.

import {
  EMIT_SLIDE_TOOL,
  EMIT_SLIDE_SCHEMA,
  coerceSlideResult,
  newUsageAcc,
  recordUsage,
  summarizeUsage,
  type GenerateSlideRequest,
  type GenerateSlideResponse,
  type DesignBrief,
} from "../../shared/generation";
import { resolveProviders, callWithFallback } from "./providers";

function env(name: string): string | undefined {
  return (typeof process !== "undefined" && process.env ? process.env[name] : undefined)?.trim() || undefined;
}

const SLIDE_SYSTEM_PROMPT = `You author ONE slide for an existing HTML presentation deck — a single <section class="slide"> element that will be INSERTED between two existing slides.

HARD CONTRACT:
- Output exactly ONE <section class="slide">…</section> (the outer element MUST carry class "slide"). No <html>/<head>/<body>, no surrounding prose, no markdown.
- REUSE the deck's own component classes and visual language — you are shown neighbouring slides; match their structure, header/footer chrome, and class names so the new slide looks native.
- Reveal animation: add class "anim" to elements that should fade in on view (use "anim-2","anim-3"… to stagger). The deck toggles these via .slide.in-view.
- It is exactly one screen: design for 100vh, do not overflow.
- NO <script>, NO <canvas>, NO Chart.js, NO external <img> URLs. For any chart/diagram use inline SVG or CSS. NO inline on* event handlers, NO javascript: URLs.
- Honor the deck palette/fonts/tone from the brief. Write in the deck's language.
- Put the user's requested CONTENT on the slide — real, specific copy, not lorem ipsum.

OUTPUT: call the emit_slide tool with html (the section), a short title, and a one-line message. Only the tool call.`;

function briefText(brief?: DesignBrief): string {
  if (!brief) return "(no brief available)";
  return JSON.stringify(
    { topic: brief.topic, palette: brief.paletteHex, fonts: brief.fonts, language: brief.language, tone: brief.toneNotes },
    null,
    2
  );
}

export async function handleGenerateSlide(req: GenerateSlideRequest): Promise<GenerateSlideResponse> {
  const prompt = (req?.prompt ?? "").trim();
  if (!prompt) throw new Error("Describe what the new slide should contain.");

  const forceMock = /^(1|true|yes|on)$/i.test(env("HTML_PPT_AI_MOCK") || "");
  const log: Record<string, unknown> = {};
  const providers = forceMock ? { primary: undefined, fallback: undefined } : resolveProviders(log);

  if (!providers.primary) {
    return { ...mockSlide(prompt), mock: true };
  }

  const where =
    req.position?.afterIndex != null
      ? `\n삽입 위치: ${req.position.afterIndex}번 슬라이드 다음${req.position.total ? ` (총 ${req.position.total}장)` : ""}.`
      : "";
  const neighbor = (req.neighborHtml ?? "").slice(0, 16000);
  const userText =
    `=== 사용자 요청 (이 내용을 담은 새 슬라이드 1장) ===\n${prompt}${where}\n\n` +
    `=== designBrief ===\n${briefText(req.brief)}\n\n` +
    (neighbor
      ? `=== 인접 슬라이드(스타일/컴포넌트 참고용 — 클래스명·구조를 그대로 재사용하라) ===\n${neighbor}`
      : `인접 슬라이드 정보가 없다 — .slide 컨테이너에 .anim 요소로 깔끔한 슬라이드를 만들어라.`);

  const usageAcc = newUsageAcc();
  const res = await callWithFallback(
    providers,
    {
      maxTokens: Number(env("HTML_PPT_SLIDE_MAX_TOKENS") || "8000"),
      images: [],
      userText,
      schema: EMIT_SLIDE_SCHEMA,
      toolName: EMIT_SLIDE_TOOL,
      toolDescription: "Return one <section class=\"slide\"> plus a title and a one-line message.",
      system: SLIDE_SYSTEM_PROMPT,
    },
    log,
    "slide"
  );

  const coerced = coerceSlideResult(res.input);
  if (!coerced) throw new Error("Slide generation returned no usable HTML.");

  const provider = String(log.slideProvider ?? log.provider ?? "");
  const model = String(log.slideModel ?? log.model ?? "");
  recordUsage(usageAcc, res.usage, provider, model);
  const usage = summarizeUsage(usageAcc, provider, model);

  return { ...coerced, usage, mock: false };
}

// A small, valid, self-contained slide so the no-key demo still inserts something
// on-topic and styled with the deck's reveal dialect.
function mockSlide(prompt: string): { html: string; title: string; message: string } {
  const safe = prompt.replace(/[<>&]/g, "").slice(0, 120);
  const title = safe.split(/[.!?\n]/)[0].slice(0, 60) || "New slide";
  const html =
    `<section class="slide">` +
    `<div class="slide-content" style="display:flex;flex-direction:column;justify-content:center;height:100%;gap:0.6em;padding:8vh 9vw;">` +
    `<h2 class="anim" style="font-size:3rem;line-height:1.1;">${title}</h2>` +
    `<p class="anim anim-2" style="font-size:1.4rem;max-width:48ch;opacity:0.85;">${safe}</p>` +
    `<ul class="anim anim-3" style="font-size:1.2rem;line-height:1.8;margin-top:1em;">` +
    `<li>핵심 포인트 1</li><li>핵심 포인트 2</li><li>핵심 포인트 3</li></ul>` +
    `</div></section>`;
  return { html, title, message: "Demo mode — inserted a sample slide (set ANTHROPIC_API_KEY or OPENAI_API_KEY for real generation)." };
}
