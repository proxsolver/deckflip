// Server-side deck generator (orchestration). Holds no provider/HTTP code — that
// lives in ./providers — and no assembly/lint — that lives in ./assemble. This
// module turns the wizard answers into a complete, editable 4-file deck by running
// the FULL editorial pipeline (docs/initial_generation_pipeline.md):
//   1) emit_plan       — design brief + slide-by-slide outline (SCQ narrative)
//   2) emit_foundation — style.css + script.js + three_scene.js + component manifest
//   3) emit_slides     — per-section slide HTML + chart-init JS (parallel)
//   assemble           — server builds index.html (head/body/script wiring)
//   4) emit_qa_fixes   — conditional prompt-only self-check/repair (lint-gated)
//
// Robustness ladder: multi-pass → single emit_deck call → mock. Generation never
// hard-fails. The DeckFiles/GeneratedDeck contract is unchanged.

import {
  EMIT_DECK_SCHEMA,
  EMIT_DECK_TOOL,
  EMIT_QA_TOOL,
  QA_SCHEMA,
  EMIT_PLAN_TOOL,
  EMIT_PLAN_SCHEMA,
  EMIT_FOUNDATION_TOOL,
  EMIT_FOUNDATION_SCHEMA,
  EMIT_SLIDES_TOOL,
  EMIT_SLIDES_SCHEMA,
  coerceDeckFiles,
  coercePlan,
  coerceFoundation,
  coerceSlides,
  MAX_UPLOADS,
  newUsageAcc,
  recordUsage,
  summarizeUsage,
  type UsageAccumulator,
  type GenerationRequest,
  type GeneratedDeck,
  type DesignBrief,
  type DeckPlan,
  type SlidePlan,
  type SlideHtml,
  type DeckAsset,
} from "../../shared/generation";
import { SINGLE_PASS_SYSTEM_PROMPT, PLAN_TASK, FOUNDATION_TASK, SLIDES_TASK } from "./prompt";
import { saveDeck, type PromptEntry } from "./storage";
import {
  env,
  webSearchEnabled,
  pMap,
  resolveProviders,
  callWithFallback,
  type Providers,
  type ModelCall,
  type ModelResult,
} from "./providers";
import { assembleDeck, deckLint, buildQaUserText, mergeQaFixes, OVERFLOW_GUARD_JS } from "./assemble";
import { mockDeck } from "./mock";

// Record one pass's usage into the accumulator, reading which provider/model
// actually served it from the log fields callWithFallback writes.
function recordPass(acc: UsageAccumulator, log: Record<string, unknown>, label: string, usage: unknown): void {
  // Fall back to the resolved primary when a retry label (e.g. "planNoSearch")
  // served the call so the provider/model fields are under a different key.
  const provider = String(log[`${label}Provider`] ?? log.provider ?? "");
  const model = String(log[`${label}Model`] ?? log.model ?? "");
  recordUsage(acc, usage, provider, model);
}

// --- public entry ----------------------------------------------------------

export async function handleGenerate(req: GenerationRequest): Promise<GeneratedDeck> {
  const topic = (req?.topic ?? "").trim();
  if (!topic) throw new Error("A topic is required to generate a deck.");
  const request: GenerationRequest = normalizeRequest(req);

  const deckId = newDeckId();
  const startedAt = Date.now();
  const log: Record<string, unknown> = { deckId, startedAt: new Date(startedAt).toISOString(), stage: "start" };

  const forceMock = /^(1|true|yes|on)$/i.test(env("HTML_PPT_AI_MOCK") || "");
  const providers = forceMock ? { primary: undefined, fallback: undefined } : resolveProviders(log);
  const usageAcc = newUsageAcc();

  // Collect uploaded/extracted images as deck assets (assets/img-N.ext) + a manifest
  // the model is told to reference via <img src="assets/...">, so the AI reuses the
  // images from the user's files in the generated deck.
  const assets = collectImageAssets(request);
  const gen: GenContext = { assets, imageManifest: imageManifestText(assets), prompts: [] };
  log.imageAssets = assets.length;

  let deck: GeneratedDeck;
  let plan: DeckPlan | undefined;

  if (!providers.primary) {
    deck = mockDeck(deckId, request);
    log.stage = "mock";
  } else {
    // Two modes (HTML_PPT_GEN_MODE):
    //   multi (default) — the structured plan→foundation→slides pipeline. Each call's
    //     output is bounded (slides built in chunks, then server-assembled), so it can't
    //     truncate on a large deck. Robust + editable; the safe default.
    //   single — ONE high-effort "sample recipe" call: the most hand-tuned per-slide
    //     design (like sample_deck), but the whole deck must fit in one ≤32K-token
    //     response, so it can truncate → falls back to multi, then mock. Best for SHORT
    //     decks; raise HTML_PPT_SINGLE_MAX_TOKENS (needs Opus 64k beta) for larger ones.
    const mode = (env("HTML_PPT_GEN_MODE") || "multi").toLowerCase();
    log.mode = mode;
    if (mode === "multi") {
      try {
        const out = await generateMultiPass(deckId, request, providers, log, usageAcc, gen);
        deck = out.deck;
        plan = out.plan;
        log.stage = "done";
      } catch (multiErr) {
        log.multiPassError = String((multiErr as Error)?.message ?? multiErr);
        console.error(`[generate] ${deckId} multi-pass failed, trying single pass:`, log.multiPassError);
        try {
          deck = await generateSinglePass(deckId, request, providers, log, usageAcc, gen);
          log.stage = "done-singlepass";
        } catch (singleErr) {
          log.singlePassError = String((singleErr as Error)?.message ?? singleErr);
          deck = mockDeck(deckId, request);
          log.stage = "mock-fallback";
        }
      }
    } else {
      try {
        deck = await generateSinglePass(deckId, request, providers, log, usageAcc, gen);
        log.stage = "done";
      } catch (singleErr) {
        // A single-pass failure is most often TRUNCATION: the whole bespoke deck
        // didn't fit in one ≤32K-token response, so the JSON came back incomplete.
        // Don't degrade straight to the deterministic mock — try the chunked
        // multi-pass pipeline (bounded per-call output, server-assembled), which
        // CAN produce a complete deck of this size. Mock is the last resort only.
        log.singlePassError = String((singleErr as Error)?.message ?? singleErr);
        console.error(`[generate] ${deckId} single pass failed, trying multi-pass:`, log.singlePassError);
        try {
          const out = await generateMultiPass(deckId, request, providers, log, usageAcc, gen);
          deck = out.deck;
          plan = out.plan;
          log.stage = "done-multipass-fallback";
        } catch (multiErr) {
          log.multiPassError = String((multiErr as Error)?.message ?? multiErr);
          console.error(`[generate] ${deckId} multi-pass fallback failed, using mock:`, log.multiPassError);
          deck = mockDeck(deckId, request);
          log.stage = "mock-fallback";
        }
      }
    }
  }

  // Attach the image assets so they travel with the deck (persisted + blob-wired).
  if (!deck.mock && assets.length) {
    deck.files = { ...deck.files, assets };
  }

  // Attach aggregated token usage + estimated cost (skipped on the mock path).
  if (!deck.mock) {
    deck.usage = summarizeUsage(usageAcc, String(log.provider ?? providers.primary?.provider ?? ""), String(log.model ?? providers.primary?.model ?? ""));
    log.usage = deck.usage;
  }

  // Persist to the local-dir backend. Storage failure must not fail generation.
  log.durationMs = Date.now() - startedAt;
  try {
    const dir = await saveDeck(deckId, deck.files, { brief: deck.brief, request, log, plan, prompts: gen.prompts });
    log.savedTo = dir;
  } catch (err) {
    log.storageError = String((err as Error)?.message ?? err);
    console.error(`[generate] storage failed for ${deckId}:`, log.storageError);
  }
  console.log(`[generate] ${deckId} ${deck.mock ? "(mock)" : ""} ${log.durationMs}ms stage=${log.stage}`);

  return deck;
}

// --- multi-pass pipeline ----------------------------------------------------

interface GenContext {
  assets: DeckAsset[];
  imageManifest: string;
  /** Accumulates every pass's prompt → persisted to _prompts.json by saveDeck. */
  prompts: PromptEntry[];
}

function nowIso(): string {
  return new Date().toISOString();
}

async function generateMultiPass(
  deckId: string,
  request: GenerationRequest,
  providers: Providers,
  log: Record<string, unknown>,
  usageAcc: UsageAccumulator,
  gen: GenContext
): Promise<{ deck: GeneratedDeck; plan: DeckPlan }> {
  // Pass 1 — plan / outline. Web search makes this the slowest call; if it
  // fails (e.g. times out), retry once WITHOUT web search so the whole multi-pass
  // survives instead of collapsing to the weaker single-call fallback.
  const planCall = (ws: boolean): ModelCall => ({
    maxTokens: Number(env("HTML_PPT_PLAN_MAX_TOKENS") || "16000"),
    images: imageDataUrls(request),
    userText: `${PLAN_TASK}\n\n=== 요청 ===\n${JSON.stringify(briefRequestForModel(request), null, 2)}`,
    schema: EMIT_PLAN_SCHEMA,
    toolName: EMIT_PLAN_TOOL,
    toolDescription: "Return the deck design brief and full slide-by-slide outline.",
    webSearch: ws,
  });
  let planRes: ModelResult;
  try {
    planRes = await callWithFallback(providers, planCall(webSearchEnabled()), log, "plan");
  } catch (err) {
    if (!webSearchEnabled()) throw err;
    log.planWebSearchAborted = String((err as Error)?.message ?? err);
    console.error(`[generate] ${deckId} plan with web search failed, retrying without search`);
    planRes = await callWithFallback(providers, planCall(false), log, "planNoSearch");
  }
  const planObj = coercePlan(planRes.input);
  if (!planObj) throw new Error("Plan pass produced no usable outline.");
  const brief = fillBrief(planObj.brief, request);
  const plan: DeckPlan = { brief, slides: planObj.slides };
  log.plan = planRes.usage;
  recordPass(usageAcc, log, "plan", planRes.usage);
  gen.prompts.push({ ts: nowIso(), kind: "generation-plan", prompt: planCall(false).userText, usage: planRes.usage });
  log.planSlides = plan.slides.length;
  log.planWebSearches = planRes.webSearchCount;

  const uses3D = !!brief.threeDMotif && brief.threeDMotif.toLowerCase() !== "none" && request.threeD !== "none";

  // Pass 2 — foundation (style.css + script.js + three_scene.js + manifest).
  const kinds = Array.from(new Set(plan.slides.map((s) => s.kind)));
  const foundationUserText =
    `${FOUNDATION_TASK}\n\n=== designBrief ===\n${JSON.stringify(brief, null, 2)}` +
    `\n\n=== 사용된 컴포넌트 종류 (이 모두에 CSS와 manifest 항목을 만들어라) ===\n${kinds.join(", ")}` +
    seedCssBlock(request) +
    (uses3D ? `\n\n=== 3D 모티프 ===\n${brief.threeDMotif} → three_scene.js 포함, window.__htmlPptScene 노출.` : `\n\n3D 모티프 none — three_scene.js 생략.`);
  const foundationRes = await callWithFallback(
    providers,
    {
      maxTokens: Number(env("HTML_PPT_FOUNDATION_MAX_TOKENS") || "32000"),
      // Foundation authors style.css — the deck's actual look — so it must SEE the
      // user's reference images (style-only cues), not just the plan's text brief.
      images: imageDataUrls(request),
      userText: foundationUserText,
      schema: EMIT_FOUNDATION_SCHEMA,
      toolName: EMIT_FOUNDATION_TOOL,
      toolDescription: "Return style.css, script.js, optional three_scene.js, and the component manifest.",
    },
    log,
    "foundation"
  );
  const foundation = coerceFoundation(foundationRes.input);
  if (!foundation) throw new Error("Foundation pass produced no usable style.css/script.js.");
  log.foundation = foundationRes.usage;
  recordPass(usageAcc, log, "foundation", foundationRes.usage);
  gen.prompts.push({ ts: nowIso(), kind: "generation-foundation", prompt: foundationUserText, usage: foundationRes.usage });
  log.foundationComponents = foundation.componentManifest.length;

  // Pass 3 — slides, by section chunk. Concurrency-limited so we don't blow a
  // provider's tokens-per-minute cap (the OpenAI fallback tier is only ~30K TPM);
  // callWithFallback retries transient 429/overload with backoff.
  const chunks = chunkPlans(plan.slides);
  log.slideChunks = chunks.length;
  const manifestText = JSON.stringify(foundation.componentManifest, null, 2);
  const slideMaxTokens = Number(env("HTML_PPT_SLIDES_MAX_TOKENS") || "16000");
  const slideConcurrency = Math.max(1, Number(env("HTML_PPT_SLIDES_CONCURRENCY") || "3"));
  const chunkResults = await pMap(
    chunks,
    slideConcurrency,
    async (chunk, ci): Promise<SlideHtml[]> => {
      try {
        const slidesUserText =
          `${SLIDES_TASK}\n\n=== designBrief ===\n${JSON.stringify(brief, null, 2)}` +
          `\n\n=== componentManifest (이 클래스/구조를 그대로 써라) ===\n${manifestText}` +
          gen.imageManifest +
          `\n\n=== 이번 섹션 슬라이드 계획 (각 index에 대해 html을 만들어라) ===\n${JSON.stringify(chunk, null, 2)}`;
        const res = await callWithFallback(
          providers,
          {
            maxTokens: slideMaxTokens,
            images: [],
            userText: slidesUserText,
            schema: EMIT_SLIDES_SCHEMA,
            toolName: EMIT_SLIDES_TOOL,
            toolDescription: "Return rendered slide HTML (and chart-init JS) for the given slide plans.",
          },
          log,
          `slides${ci}`
        );
        recordPass(usageAcc, log, `slides${ci}`, res.usage);
        gen.prompts.push({ ts: nowIso(), kind: "generation-slides", prompt: slidesUserText, usage: res.usage });
        return coerceSlides(res.input);
      } catch (err) {
        log[`slides${ci}Failed`] = String((err as Error)?.message ?? err);
        return [];
      }
    }
  );
  const slides = chunkResults.flat();
  if (!slides.length) throw new Error("Slides pass produced no slides.");
  log.slidesRendered = slides.length;

  // Assemble index.html / script.js deterministically.
  let files = assembleDeck(brief, foundation, slides, request, uses3D);

  // Pass 4 — lint-gated, prompt-only QA/repair (same gating as before).
  const qaMode = (env("HTML_PPT_QA_MODE") || "auto").toLowerCase();
  const lint = deckLint(files);
  log.lintIssues = lint.issues;
  const runQa = qaMode === "always" || (qaMode !== "off" && lint.issues.length > 0);
  if (runQa) {
    try {
      const qaUserText = buildQaUserText(files, lint.issues);
      const qa = await callWithFallback(
        providers,
        {
          maxTokens: Number(env("HTML_PPT_QA_MAX_TOKENS") || "16000"),
          images: [],
          userText: qaUserText,
          schema: QA_SCHEMA,
          toolName: EMIT_QA_TOOL,
          toolDescription: "Return issues found and the full corrected contents of ONLY the files you changed.",
        },
        log,
        "qa"
      );
      log.qa = qa.usage;
      recordPass(usageAcc, log, "qa", qa.usage);
      gen.prompts.push({ ts: nowIso(), kind: "generation-qa", prompt: qaUserText, usage: qa.usage });
      const issues = (qa.input as Record<string, unknown>)?.issues;
      log.qaIssues = Array.isArray(issues) ? issues : [];
      const merged = mergeQaFixes(files, (qa.input as Record<string, unknown>)?.files);
      if (merged.changed) files = merged.files;
    } catch (err) {
      log.qaError = String((err as Error)?.message ?? err);
    }
  } else {
    log.qaSkipped = qaMode === "off" ? "disabled" : "lint clean";
  }

  const message = `Generated a ${slides.length}-slide editorial deck.`;
  return { deck: { deckId, files, brief, message, mock: false }, plan };
}

// Group the outline into per-chapter chunks for pass 3. Breaks on a CHAPTER
// change (the leading number of sectionNo, so "01—2" and "01—3" stay together)
// and caps chunk size so each call's output stays bounded. Coarse on purpose:
// fewer, larger chunks = fewer concurrent calls (kinder to TPM limits) and more
// per-call coherence.
function chapterKey(s: SlidePlan): string {
  return (s.sectionNo || "").split(/[—\-.]/)[0].trim();
}
function chunkPlans(slides: SlidePlan[], max = 6): SlidePlan[][] {
  const chunks: SlidePlan[][] = [];
  let cur: SlidePlan[] = [];
  for (const s of slides) {
    const sameChapter = cur.length > 0 && chapterKey(cur[0]) === chapterKey(s);
    const boundary = cur.length >= max || (cur.length > 0 && !sameChapter && !!chapterKey(s));
    if (cur.length && boundary) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// --- single-pass "sample recipe" --------------------------------------------
// ONE high-effort emit_deck call using the SINGLE_PASS_SYSTEM_PROMPT: the model
// authors the complete, BESPOKE 4-file deck itself (no server assembly), like how
// sample_deck was made. Web research + a lint-gated QA repair, then the overflow
// guard is appended for the same clip-safety the assembled path gets.
async function generateSinglePass(
  deckId: string,
  request: GenerationRequest,
  providers: Providers,
  log: Record<string, unknown>,
  usageAcc: UsageAccumulator,
  gen: GenContext
): Promise<GeneratedDeck> {
  const maxTokens = Number(env("HTML_PPT_SINGLE_MAX_TOKENS") || env("HTML_PPT_GEN_MAX_TOKENS") || "32000");
  const mk = (ws: boolean): ModelCall => ({
    maxTokens,
    images: imageDataUrls(request),
    userText:
      `위 시스템 지침대로 완성된 bespoke 4파일 덱을 emit_deck 도구로 한 번에 반환하라. 슬라이드마다 맞춤 디자인으로, sample_deck 수준의 완성도로.\n\n=== 요청 ===\n${JSON.stringify(briefRequestForModel(request), null, 2)}` +
      seedCssBlock(request) +
      gen.imageManifest,
    schema: EMIT_DECK_SCHEMA,
    toolName: EMIT_DECK_TOOL,
    toolDescription: "Return the complete bespoke deck as four files plus a compact design brief.",
    webSearch: ws,
    system: SINGLE_PASS_SYSTEM_PROMPT,
  });

  // Web research, with a no-search retry so a flaky search call can't fail the run.
  let genRes: ModelResult;
  try {
    genRes = await callWithFallback(providers, mk(webSearchEnabled()), log, "single");
  } catch (err) {
    if (!webSearchEnabled()) throw err;
    log.singleWebSearchAborted = String((err as Error)?.message ?? err);
    genRes = await callWithFallback(providers, mk(false), log, "singleNoSearch");
  }
  log.single = genRes.usage;
  recordPass(usageAcc, log, "single", genRes.usage);
  gen.prompts.push({ ts: nowIso(), kind: "generation-single", prompt: mk(false).userText, usage: genRes.usage });
  log.singleWebSearches = genRes.webSearchCount;
  if (/max_tokens|max_output_tokens|length|incomplete/.test(genRes.stopReason)) log.singleTruncated = true;

  let files = coerceDeckFiles((genRes.input as Record<string, unknown>)?.files);
  if (!files) throw new Error("Single-pass generation returned no usable index.html.");
  const brief = fillBrief(coerceBrief((genRes.input as Record<string, unknown>)?.designBrief), request);
  let message =
    typeof (genRes.input as Record<string, unknown>)?.message === "string"
      ? ((genRes.input as Record<string, unknown>).message as string)
      : "Deck generated.";

  // Lint-gated, prompt-only QA/repair (same cached prefix → uses SINGLE_PASS prompt).
  const qaMode = (env("HTML_PPT_QA_MODE") || "auto").toLowerCase();
  const lint = deckLint(files);
  log.lintIssues = lint.issues;
  const runQa = qaMode === "always" || (qaMode !== "off" && lint.issues.length > 0);
  if (runQa) {
    try {
      const qaUserText = buildQaUserText(files, lint.issues);
      const qa = await callWithFallback(
        providers,
        {
          maxTokens: Number(env("HTML_PPT_QA_MAX_TOKENS") || "16000"),
          images: [],
          userText: qaUserText,
          schema: QA_SCHEMA,
          toolName: EMIT_QA_TOOL,
          toolDescription: "Return issues found and the full corrected contents of ONLY the files you changed.",
          system: SINGLE_PASS_SYSTEM_PROMPT,
        },
        log,
        "qa"
      );
      log.qa = qa.usage;
      recordPass(usageAcc, log, "qa", qa.usage);
      gen.prompts.push({ ts: nowIso(), kind: "generation-qa", prompt: qaUserText, usage: qa.usage });
      const issues = (qa.input as Record<string, unknown>)?.issues;
      log.qaIssues = Array.isArray(issues) ? issues : [];
      const merged = mergeQaFixes(files, (qa.input as Record<string, unknown>)?.files);
      if (merged.changed) {
        files = merged.files;
        if (Array.isArray(issues) && issues.length) message += ` (self-check fixed ${issues.length})`;
      }
    } catch (err) {
      log.qaError = String((err as Error)?.message ?? err);
    }
  } else {
    log.qaSkipped = qaMode === "off" ? "disabled" : "lint clean";
  }

  // Clip-safety: same overflow guard the assembled path appends.
  files = { ...files, scriptJs: (files.scriptJs || "") + OVERFLOW_GUARD_JS };
  return { deckId, files, brief, message, mock: false };
}

// --- request normalization & user-message builders --------------------------

function normalizeRequest(req: GenerationRequest): GenerationRequest {
  const uploads = Array.isArray(req.uploads) ? req.uploads.slice(0, MAX_UPLOADS) : [];
  return {
    topic: req.topic.trim(),
    preset: req.preset ?? "auto",
    audience: req.audience ?? "auto",
    length: req.length ?? "auto",
    language: req.language ?? "auto",
    threeD: req.threeD ?? "auto",
    title: typeof req.title === "string" ? req.title.trim() || undefined : undefined,
    format: req.format ?? "auto",
    persona: req.persona && typeof req.persona === "object" ? req.persona : undefined,
    candidateSeed: req.candidateSeed && typeof req.candidateSeed === "object" ? req.candidateSeed : undefined,
    detailByStep: req.detailByStep && typeof req.detailByStep === "object" ? req.detailByStep : undefined,
    extraPrompt: typeof req.extraPrompt === "string" ? req.extraPrompt.trim() || undefined : undefined,
    uploads,
  };
}

function newDeckId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `deck-${t}-${r}`;
}

// Image uploads → data URLs the providers format into vision parts. Includes both
// "image" (content, also placed as assets) and "reference" (style-only) images so
// the model can SEE references to absorb their design DNA without placing them.
function imageDataUrls(req: GenerationRequest): string[] {
  return (req.uploads ?? [])
    .filter((u) => (u.kind === "image" || u.kind === "reference") && u.dataUrl)
    .map((u) => u.dataUrl as string);
}

// Image uploads → deck assets (assets/img-N.ext). The model is shown the bytes
// (vision) AND told to reference them by path via the manifest, so they end up in
// the deck rather than being only "seen". Capped to keep payloads sane.
function collectImageAssets(req: GenerationRequest): DeckAsset[] {
  const imgs = (req.uploads ?? []).filter((u) => u.kind === "image" && u.dataUrl).slice(0, 12);
  return imgs.map((u, i) => ({
    path: `assets/img-${i + 1}.${extForMime(u.mime, u.name)}`,
    dataUrl: u.dataUrl as string,
    caption: u.name || `image ${i + 1}`,
  }));
}

function extForMime(mime: string, name: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  if (m.includes("svg")) return "svg";
  const ext = /\.([a-z0-9]+)$/i.exec(name || "")?.[1]?.toLowerCase();
  return ext || "png";
}

// The instruction block (appended to the relevant pass's user text) listing the
// images the AI may place. Empty when there are no images.
function imageManifestText(assets: DeckAsset[]): string {
  if (!assets.length) return "";
  const list = assets.map((a) => ({ path: a.path, caption: a.caption ?? "" }));
  return (
    `\n\n=== 사용 가능한 이미지 (사용자 파일에서 추출) ===\n` +
    `아래 이미지들이 덱에 함께 저장된다. 주제에 맞는 슬라이드에 \`<img src="경로">\`로 **실제로 배치하라**(억지로 다 넣지는 말 것). ` +
    `인라인 data: URL을 쓰지 말고 반드시 아래 경로 문자열을 그대로 src로 써라.\n${JSON.stringify(list, null, 2)}`
  );
}

// When the user picked a candidate, lock its style.css as the seed to extend.
function seedCssBlock(req: GenerationRequest): string {
  const css = req.candidateSeed?.styleCss?.trim();
  if (!css) return "";
  return (
    `\n\n=== 확정 스타일 시드 (사용자가 고른 후보의 style.css) ===\n` +
    `이 토큰/팔레트/폰트/느낌을 **유지하고 확장**하라(완전히 바꾸지 말 것). 전체 덱이 이 후보와 일관돼야 한다.\n\`\`\`css\n${css.slice(0, 8000)}\n\`\`\``
  );
}

// Terse, structured restatement of the wizard answers (keeps the user turn small).
function briefRequestForModel(req: GenerationRequest): Record<string, unknown> {
  const textUploads = (req.uploads ?? [])
    .filter((u) => u.kind !== "image" && u.text)
    .map((u) => ({ name: u.name, kind: u.kind, content: (u.text ?? "").slice(0, 8000) }));
  return {
    instruction:
      "위 시스템 지침을 지켜라. auto는 주제에서 네가 정한다. persona(사용자 취향)는 디자인의 가장 큰 결정 요인이니 팔레트·폰트·톤·밀도에 반드시 반영하라. format은 덱의 성격(interactive=클릭/모션 위주, presentation=발표용 슬라이드, document=정보 밀도 높은 리포트)이다.",
    topic: req.topic,
    title: req.title ?? "",
    preset: req.preset,
    format: req.format ?? "auto",
    persona: req.persona ?? null,
    audience: req.audience,
    length: req.length,
    language: req.language,
    threeD: req.threeD,
    details: req.detailByStep ?? {},
    extraPrompt: req.extraPrompt ?? "",
    imageUploadCount: (req.uploads ?? []).filter((u) => u.kind === "image" && u.dataUrl).length,
    textUploads,
  };
}

// Fill required brief fields from the request when the model left them blank.
// When the user locked a candidate, its style (palette/fonts/preset) wins so the
// full deck stays consistent with the previewed sample.
function fillBrief(brief: DesignBrief, req: GenerationRequest): DesignBrief {
  const seed = req.candidateSeed?.brief;
  const merged: DesignBrief = {
    ...brief,
    topic: brief.topic || req.topic,
    presetUsed: brief.presetUsed || (req.preset === "auto" ? "light-editorial" : req.preset),
    language: brief.language || (req.language === "en" ? "en" : "ko"),
    threeDMotif: brief.threeDMotif || (req.threeD === "none" ? "none" : ""),
  };
  if (seed) {
    if (seed.paletteHex?.length) merged.paletteHex = seed.paletteHex;
    if (seed.fonts?.length) merged.fonts = seed.fonts;
    if (seed.presetUsed) merged.presetUsed = seed.presetUsed;
  }
  return merged;
}

function coerceBrief(raw: unknown): DesignBrief {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v ? v : fallback);
  return {
    topic: str(r.topic),
    presetUsed: str(r.presetUsed),
    paletteHex: strArr(r.paletteHex),
    fonts: strArr(r.fonts),
    sections: strArr(r.sections),
    threeDMotif: str(r.threeDMotif),
    language: str(r.language),
    toneNotes: str(r.toneNotes),
  };
}
