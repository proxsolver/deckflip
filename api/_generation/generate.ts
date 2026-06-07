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
  EMIT_QA_TOOL,
  QA_SCHEMA,
  EMIT_PLAN_TOOL,
  EMIT_PLAN_SCHEMA,
  EMIT_FOUNDATION_TOOL,
  EMIT_FOUNDATION_SCHEMA,
  EMIT_SLIDES_TOOL,
  EMIT_SLIDES_SCHEMA,
  parseDelimitedDeck,
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
  IMAGE_SLOT_ATTR,
  IMAGE_REF_ATTR,
  IMAGE_INTENT_ATTR,
} from "../../shared/generation";
import { SINGLE_PASS_SYSTEM_PROMPT, PLAN_TASK, FOUNDATION_TASK, SLIDES_TASK } from "./prompt";
import { saveDeck, saveExportRequest, type PromptEntry } from "./storage";
import {
  env,
  webSearchEnabled,
  pMap,
  resolveProviders,
  callWithFallback,
  callRawWithFallback,
  type Providers,
  type ModelCall,
  type ModelResult,
  type RawCall,
  type RawResult,
} from "./providers";
import { assembleDeck, deckLint, buildQaUserText, mergeQaFixes, OVERFLOW_GUARD_JS } from "./assemble";
import { measureDeck } from "./render-qa";
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

  // Prompt-export mode: don't call the API and don't build a mock template. Emit the
  // EXACT generation prompt so the user can run it in a Claude Code session (their
  // subscription = no per-token billing, same Opus 4.8). Persist the request + prompt
  // + image assets to generated/<deckId>/ so Claude Code picks them up and writes the
  // deck there; the app's "Load it" button pulls it back via /api/load-generated.
  if (forceMock) {
    const promptText = buildGenerationPrompt(deckId, request, gen.imageManifest);
    try {
      log.savedTo = await saveExportRequest(deckId, request, promptText, assets);
    } catch (err) {
      log.storageError = String((err as Error)?.message ?? err);
      console.error(`[generate] ${deckId} export-request save failed:`, log.storageError);
    }
    log.stage = "prompt-export";
    log.durationMs = Date.now() - startedAt;
    console.log(`[generate] ${deckId} (prompt-export) ${log.durationMs}ms`);
    return {
      deckId,
      files: { indexHtml: "", styleCss: "", scriptJs: "" },
      brief: fillBrief(coerceBrief({}), request),
      message: "Prompt-export mode — copy the prompt into a Claude Code session to generate this deck.",
      mock: true,
      promptExport: { kind: "generation", deckId, prompt: promptText, docPath: GEN_DOC_PATH, dir: `generated/${deckId}` },
    };
  }

  let deck: GeneratedDeck;
  let plan: DeckPlan | undefined;

  if (!providers.primary) {
    deck = mockDeck(deckId, request);
    log.stage = "mock";
  } else {
    // Two modes (HTML_PPT_GEN_MODE):
    //   single (default) — ONE coherent-author pass that emits the whole bespoke deck
    //     as DELIMITED free-text files (not one structured-output JSON), streamed, with
    //     continuation-on-truncation. A cut-off response is now SALVAGEABLE (every
    //     completed file kept; a partial index.html = a shorter deck), so the single
    //     author's coherence no longer costs the old "tokens spent, nothing returned"
    //     failure. Closest to the Claude Code result. Falls back to multi, then mock.
    //   multi — the structured plan→foundation→slides pipeline; output bounded per call
    //     (chunked + server-assembled). Robust at any size but loses cross-slide
    //     coherence (chunks render blind). Opt in for very large / cost-bounded runs.
    const mode = (env("HTML_PPT_GEN_MODE") || "single").toLowerCase();
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

// --- single-pass coherent author --------------------------------------------
// ONE coherent-author pass using SINGLE_PASS_SYSTEM_PROMPT: the model writes the
// whole BESPOKE deck itself (no server assembly), like how sample_deck was made —
// but emitted as DELIMITED free-text files (not one structured-output JSON) and
// STREAMED, so a truncated response is salvageable instead of a total loss. On
// truncation we CONTINUE the assistant turn (resume where it stopped) rather than
// paying for a full multi-pass regen. Then the same lint-gated QA repair + overflow
// guard the other paths use.
const TRUNCATED_RE = /max_tokens|max_output_tokens|length|incomplete/i;

async function generateSinglePass(
  deckId: string,
  request: GenerationRequest,
  providers: Providers,
  log: Record<string, unknown>,
  usageAcc: UsageAccumulator,
  gen: GenContext
): Promise<GeneratedDeck> {
  const maxTokens = Number(env("HTML_PPT_SINGLE_MAX_TOKENS") || env("HTML_PPT_GEN_MAX_TOKENS") || "64000");
  const images = imageDataUrls(request);
  const userText =
    `위 시스템 지침대로 완성된 bespoke 덱을 §출력 형식의 구분자 마커(===FILE: …===)로 작성하라. 슬라이드마다 맞춤 디자인으로, §샘플 수준의 완성도로. length가 auto면 32~45장.\n\n=== 요청 ===\n${JSON.stringify(briefRequestForModel(request), null, 2)}` +
    seedCssBlock(request) +
    gen.imageManifest;
  const mk = (ws: boolean, assistantPrefix?: string): RawCall => ({
    maxTokens,
    images: assistantPrefix ? [] : images, // continuation needs no re-sent images
    system: SINGLE_PASS_SYSTEM_PROMPT,
    userText,
    assistantPrefix,
    webSearch: ws,
  });

  // First call (web research), with a no-search retry so a flaky search can't fail it.
  let res: RawResult;
  try {
    res = await callRawWithFallback(providers, mk(webSearchEnabled()), log, "single");
  } catch (err) {
    if (!webSearchEnabled()) throw err;
    log.singleWebSearchAborted = String((err as Error)?.message ?? err);
    res = await callRawWithFallback(providers, mk(false), log, "singleNoSearch");
  }
  log.single = res.usage;
  recordPass(usageAcc, log, "single", res.usage);
  gen.prompts.push({ ts: nowIso(), kind: "generation-single", prompt: userText, usage: res.usage });
  log.singleWebSearches = res.webSearchCount;

  let accumulated = res.text;
  let stop = res.stopReason;
  const seenEnd = () => parseDelimitedDeck(accumulated).complete;

  // Continuation loop: resume the truncated turn instead of regenerating. Stops at
  // the END sentinel, when the model adds nothing, or at the continuation cap.
  const maxCont = Math.max(0, Number(env("HTML_PPT_SINGLE_MAX_CONTINUATIONS") || "4"));
  for (let i = 0; i < maxCont && TRUNCATED_RE.test(stop) && !seenEnd(); i++) {
    log.singleContinuations = i + 1;
    let cont: RawResult;
    try {
      cont = await callRawWithFallback(providers, mk(false, accumulated), log, `singleCont${i}`);
    } catch (err) {
      log[`singleCont${i}Error`] = String((err as Error)?.message ?? err);
      break;
    }
    recordPass(usageAcc, log, `singleCont${i}`, cont.usage);
    if (!cont.text) break;
    accumulated += cont.text;
    stop = cont.stopReason;
  }
  if (TRUNCATED_RE.test(stop) && !seenEnd()) log.singleTruncated = true;

  const parsed = parseDelimitedDeck(accumulated);
  let files = parsed.files;
  if (!files) throw new Error("Single-pass generation returned no usable index.html.");
  log.singleComplete = parsed.complete;
  const brief = fillBrief(coerceBrief(parsed.brief), request);
  let message = parsed.message || "Deck generated.";

  // QA/repair. deckLint() does cheap string checks; measureDeck() renders the deck
  // in a headless browser and MEASURES layout failures (slides that overflow the
  // 100vh frame) that string-lint can't see — no model tokens, no-ops if playwright
  // isn't installed. Both feed the SAME emit_qa_fixes call, so the render loop costs
  // ~0 extra tokens over the QA pass that already runs.
  const qaMode = (env("HTML_PPT_QA_MODE") || "auto").toLowerCase();
  const lint = deckLint(files);
  log.lintIssues = lint.issues;
  const renderIssues = qaMode === "off" ? [] : await measureDeck(files, log);
  const qaIssuesIn = [...lint.issues, ...renderIssues];
  const runQa = qaMode === "always" || (qaMode !== "off" && qaIssuesIn.length > 0);
  if (runQa) {
    try {
      const qaUserText = buildQaUserText(files, qaIssuesIn);
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
    log.qaSkipped = qaMode === "off" ? "disabled" : "lint+render clean";
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
// images available to place. The model does NOT emit <img> tags — it only RESERVES
// space and records its intent via an empty slot; the app fills the real image in
// (see shared/generation/image-slots.ts + fillImageSlots in project-io.ts). Empty
// when there are no images.
function imageManifestText(assets: DeckAsset[]): string {
  if (!assets.length) return "";
  const list = assets.map((a) => ({ path: a.path, caption: a.caption ?? "" }));
  return (
    `\n\n=== 사용 가능한 이미지 (사용자 파일에서 추출) ===\n` +
    `아래 이미지들이 덱과 함께 저장된다. **직접 \`<img>\` 태그를 쓰지 마라.** ` +
    `대신 이미지가 들어갈 자리에 빈 슬롯 요소를 만들어라:\n` +
    `\`<figure ${IMAGE_SLOT_ATTR} ${IMAGE_REF_ATTR}="assets/img-2.png" ${IMAGE_INTENT_ATTR}="이 자리에 어떤 이미지가 좋은지 짧은 설명"></figure>\`\n` +
    `- \`${IMAGE_REF_ATTR}\`: 이 슬롯에 넣을 이미지 경로(아래 목록 중 하나). 적합한 게 없으면 생략.\n` +
    `- \`${IMAGE_INTENT_ATTR}\`: 어떤 이미지인지 짧은 설명(앱이 매칭·대체 텍스트로 사용). 항상 채워라.\n` +
    `실제 \`<img>\` 삽입·크기·object-fit은 앱이 처리한다. 슬롯에는 자리 크기/비율만 CSS로 잡아라(예: \`aspect-ratio\`, \`width\`, 배경색 플레이스홀더). ` +
    `이미지가 모자라도 억지로 다 쓰지 말고, 내용에 맞는 자리에만 슬롯을 둬라.\n${JSON.stringify(list, null, 2)}`
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

// The pipeline doc Claude Code follows in prompt-export mode (repo-relative).
const GEN_DOC_PATH = "docs/ai-initial-generation-pipeline.md";

// Build the copyable generation prompt for prompt-export mode. The embedded request
// block reuses the SAME builders as the single-pass userText (briefRequestForModel /
// seedCssBlock / imageManifest), so what Claude Code sees matches what the API would
// receive — only the wrapper (follow the doc, write to generated/<id>/) differs.
function buildGenerationPrompt(deckId: string, req: GenerationRequest, imageManifest: string): string {
  return (
    `너는 Slidesmith의 덱 생성 엔진이다. \`${GEN_DOC_PATH}\` (섹션 1–3)를 **정확히** 따라 완성된 덱을 만들고, 파일을 \`generated/${deckId}/\`에 직접 써라.\n\n` +
    `이것은 Claude API 대신 Claude Code(구독, 동일한 Opus 4.8 모델)로 로컬에서 덱을 생성하는 경로다. 위 문서의 단일 패스 완성본 방식대로 전체 덱(length가 auto면 32~45장)을 한 번에 작성하라 — 너는 파일을 직접 쓰므로 응답 길이 제한이 없다.\n\n` +
    `deckId: ${deckId}\n` +
    `출력 폴더: generated/${deckId}/\n` +
    `필수 파일: index.html, style.css, script.js, (3D를 쓰면) three_scene.js, _brief.json\n\n` +
    `=== 요청 (사용자 위저드 입력) ===\n${JSON.stringify(briefRequestForModel(req), null, 2)}` +
    seedCssBlock(req) +
    imageManifest +
    `\n\n완료하면 사용자에게 앱에서 **"Load it"** 버튼을 눌러 덱을 불러오라고 알려라.`
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
