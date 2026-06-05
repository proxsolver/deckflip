// Candidate previews — generate N (default 3) single-slide style samples the user
// picks between BEFORE the full deck is built. Each candidate is a complete,
// self-contained hero/title slide (inlined CSS) plus the style.css + brief it
// would seed the full deck with. This is the generation path (it emits HTML), so
// it does NOT go through the edit validator; the samples render in the sandboxed
// preview iframe. Reuses the provider layer (Anthropic Opus → OpenAI fallback);
// no key → 3 deterministic mock variants so the flow works secret-free.

import {
  EMIT_CANDIDATE_TOOL,
  EMIT_CANDIDATE_SCHEMA,
  coerceCandidate,
  newUsageAcc,
  recordUsage,
  summarizeUsage,
  type GenerateCandidatesRequest,
  type GenerateCandidatesResponse,
  type CandidateResult,
} from "../../shared/generation";
import { PIPELINE_DOC } from "./prompt";
import { env, resolveProviders, callWithFallback, pMap, type Providers } from "./providers";

// Distinct visual directions so the 3 samples genuinely differ. The model still
// honors topic/persona/format/preset — these only nudge the emphasis.
const DIRECTIONS = [
  { label: "Editorial", hint: "warm, premium editorial — generous whitespace, refined serif display, 1px rules, restrained accent" },
  { label: "Bold", hint: "high-contrast and dramatic — oversized type, a confident accent color, strong hierarchy" },
  { label: "Modern", hint: "clean modern minimal — crisp grid, geometric sans, calm palette, subtle depth" },
];

const CANDIDATE_SYSTEM = `${PIPELINE_DOC}

---
## 임무: 후보 샘플 1장 (emit_candidate)
너는 전체 덱이 아니라, 그 덱의 **대표 표지/히어로 슬라이드 1장**을 디자인한다 — 사용자가 방향을 고르도록 보여주는 **비주얼 샘플**이다.
- html: 완전한 단독 HTML 문서 1개. \`<!DOCTYPE html>\` … \`</html>\`, **CSS는 \`<style>\`에 인라인**, 외부 JS 불필요. 16:9(1920×1080) 비율을 가정하고 \`html,body{margin:0}\`로 꽉 차게. 한 화면 안에 완결.
- css: 이 방향으로 전체 덱을 만들 때 쓸 style.css(토큰 + 베이스 규칙). 풀 덱 생성의 시드가 된다.
- designBrief: 팔레트(HEX)·폰트·톤·섹션(예상)·프리셋·언어·3D 모티프(없으면 "none").
샘플은 시각적으로 매력적이고 그 방향을 분명히 드러내야 한다. 플레이스홀더·메타설명 금지. 카피 규칙(금지어·선언형 제목·쉬운 단어) 준수.`;

export async function handleGenerateCandidates(req: GenerateCandidatesRequest): Promise<GenerateCandidatesResponse> {
  const topic = (req?.topic ?? "").trim();
  if (!topic) throw new Error("A topic is required to generate candidates.");
  const count = Math.max(1, Math.min(3, req.count ?? 3));

  const forceMock = /^(1|true|yes|on)$/i.test(env("HTML_PPT_AI_MOCK") || "");
  const log: Record<string, unknown> = {};
  const providers: Providers = forceMock ? { primary: undefined, fallback: undefined } : resolveProviders(log);

  if (!providers.primary) {
    return { candidates: mockCandidates(req, count), mock: true };
  }

  const usageAcc = newUsageAcc();
  const maxTokens = Number(env("HTML_PPT_CANDIDATE_MAX_TOKENS") || "8000");
  const results = await pMap(
    DIRECTIONS.slice(0, count),
    Math.min(count, 3),
    async (dir, i): Promise<CandidateResult | null> => {
      try {
        const res = await callWithFallback(
          providers,
          {
            maxTokens,
            images: [],
            userText: candidateUserText(req, dir),
            schema: EMIT_CANDIDATE_SCHEMA,
            toolName: EMIT_CANDIDATE_TOOL,
            toolDescription: "Return ONE standalone hero-slide HTML sample plus the style.css and brief it seeds.",
            system: CANDIDATE_SYSTEM,
          },
          log,
          `candidate${i}`
        );
        recordUsage(usageAcc, res.usage, String(log[`candidate${i}Provider`] ?? log.provider ?? ""), String(log[`candidate${i}Model`] ?? log.model ?? ""));
        return coerceCandidate(res.input, `cand-${i}-${dir.label.toLowerCase()}`);
      } catch (err) {
        log[`candidate${i}Failed`] = String((err as Error)?.message ?? err);
        return null;
      }
    }
  );

  const candidates = results.filter((c): c is CandidateResult => !!c);
  if (!candidates.length) return { candidates: mockCandidates(req, count), mock: true };
  const usage = summarizeUsage(usageAcc, String(log.provider ?? ""), String(log.model ?? ""));
  return { candidates, mock: false, usage };
}

function candidateUserText(req: GenerateCandidatesRequest, dir: { label: string; hint: string }): string {
  const persona = req.persona
    ? `\n=== 사용자 페르소나/취향 (디자인의 가장 큰 결정 요인 — 반드시 반영) ===\n${JSON.stringify(req.persona, null, 2)}`
    : "";
  return (
    `=== 방향 (이 후보의 시각적 성격) ===\n${dir.label}: ${dir.hint}` +
    `\n\n=== 요청 ===\n${JSON.stringify(
      {
        topic: req.topic,
        title: req.title ?? "",
        preset: req.preset ?? "auto",
        format: req.format ?? "auto",
        audience: req.audience ?? "auto",
        language: req.language ?? "auto",
      },
      null,
      2
    )}${persona}` +
    `\n\n이 방향으로 표지/히어로 슬라이드 1장을 emit_candidate로 돌려줘라.`
  );
}

// --- mock ------------------------------------------------------------------

function mockCandidates(req: GenerateCandidatesRequest, count: number): CandidateResult[] {
  const title = (req.title || req.topic || "Your Deck").slice(0, 80);
  const palettes = [
    { name: "Editorial", bg: "#FAF8F3", ink: "#1A1A1A", accent: "#B0852F", font: "Georgia, 'Noto Serif KR', serif" },
    { name: "Bold", bg: "#0E0E10", ink: "#F5F2EA", accent: "#C9A557", font: "'Segoe UI', system-ui, sans-serif" },
    { name: "Modern", bg: "#FFFFFF", ink: "#101418", accent: "#2D6CDF", font: "'Segoe UI', Inter, system-ui, sans-serif" },
  ];
  return palettes.slice(0, count).map((p, i) => ({
    candidateId: `mock-${i}-${p.name.toLowerCase()}`,
    label: `${p.name} (demo)`,
    css: `:root{--bg:${p.bg};--ink:${p.ink};--accent:${p.accent}}body{font-family:${p.font}}`,
    brief: {
      topic: req.topic,
      presetUsed: p.name.toLowerCase(),
      paletteHex: [p.bg, p.ink, p.accent],
      fonts: [p.font],
      sections: [],
      threeDMotif: "none",
      language: req.language === "en" ? "en" : "ko",
      toneNotes: `Demo ${p.name} direction.`,
    },
    html: mockSlideHtml(title, p),
  }));
}

function mockSlideHtml(title: string, p: { bg: string; ink: string; accent: string; font: string }): string {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%}
body{background:${p.bg};color:${p.ink};font-family:${p.font};display:flex;align-items:center;justify-content:center;height:100vh}
.wrap{padding:8vmin;max-width:80%}
.eyebrow{letter-spacing:.3em;text-transform:uppercase;font-size:1.2vmin;color:${p.accent};margin-bottom:3vmin}
h1{font-size:7vmin;line-height:1.05;margin:0 0 3vmin}
.rule{width:18vmin;height:3px;background:${p.accent}}
.foot{position:fixed;bottom:5vmin;left:8vmin;font-size:1.4vmin;opacity:.6}
</style></head><body><div class="wrap">
<div class="eyebrow">Preview · Demo mode</div>
<h1>${esc(title)}</h1>
<div class="rule"></div>
</div><div class="foot">Slidesmith · candidate sample</div></body></html>`;
}
