// Deterministic deck assembly + the zero-token lint that gates the QA pass. The
// server owns index.html structure (head, <main class="presentation">, body
// chrome, script order) so the editor contract holds regardless of model drift,
// and stitches every slide's chartInitJs onto script.js so Chart.js configs keep
// their functions (formatters/callbacks). Also exposes the helpers the QA repair
// pass and the mock generator share (escapeHtml, buildQaUserText).

import type { DesignBrief, FoundationResult, SlideHtml, GenerationRequest, DeckFiles } from "../../shared/generation";
import { QA_CHECKLIST } from "./prompt";

// Deterministic safety net appended to every deck's script.js: if any slide's
// content exceeds its 100vh box, give THAT slide internal vertical scroll so the
// content is never invisibly clipped (the page-14 problem). Editor-safe — it only
// toggles overflow-y, never reparents or writes transform. Disabled under headless
// (print) since print uses the fixed 1920×1080 @page box.
export const OVERFLOW_GUARD_JS = `

/* ---- overflow guard (appended at assembly) ---- */
(function(){
  function fitSlides(){
    if (navigator.userAgent.indexOf('HeadlessChrome') !== -1) return;
    var slides = document.querySelectorAll('.presentation .slide, main.presentation > section');
    for (var i=0;i<slides.length;i++){
      var s = slides[i];
      s.style.overflowY = (s.scrollHeight - s.clientHeight > 4) ? 'auto' : '';
    }
  }
  addEventListener('load', fitSlides);
  addEventListener('resize', fitSlides);
  setTimeout(fitSlides, 500);
})();
`;

// Guaranteed positioning for the 3D background layer, injected last in <head> so it
// wins over any (missing or wrong) authored rule. Covers ONLY structural layering —
// fixed full-screen, behind content, non-interactive — never the look (color/opacity
// of the scene stays the deck author's three_scene.js). Mirrors the contract in
// prompt.ts §5. The editor's #three-canvas-container selection/print rules still apply.
export const THREE_LAYER_BASE_CSS = `<style id="html-ppt-3d-base">
  #three-canvas-container{position:fixed;inset:0;width:100vw;height:100vh;z-index:0;pointer-events:none}
  #three-canvas-container canvas{display:block;width:100%;height:100%}
  .presentation{position:relative;z-index:1}
</style>`;

// Build the final 4 files from the foundation + rendered slides.
export function assembleDeck(
  brief: DesignBrief,
  foundation: FoundationResult,
  slides: SlideHtml[],
  request: GenerationRequest,
  uses3D: boolean
): DeckFiles {
  const lang = (brief.language || (request.language === "en" ? "en" : "ko")).toLowerCase().startsWith("en") ? "en" : "ko";
  const title = escapeHtml(brief.topic || request.topic);

  const ordered = slides.slice().sort((a, b) => a.index - b.index);
  const slideHtml = ordered.map((s) => s.html.trim()).join("\n\n");

  const chartInit = ordered
    .map((s) => (s.chartInitJs || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const usesChart = !!chartInit || /new\s+Chart\s*\(/.test(foundation.scriptJs) || /__chartInit/.test(foundation.scriptJs) || /<canvas/i.test(slideHtml);

  // script.js = guard + foundation + per-slide chart inits + overflow guard.
  let scriptJs = "window.__chartInit = window.__chartInit || {};\n" + foundation.scriptJs;
  if (chartInit) scriptJs += "\n\n/* ---- per-slide chart inits (appended at assembly) ---- */\n" + chartInit + "\n";
  scriptJs += OVERFLOW_GUARD_JS;

  // <head>: fonts + style.css + (when 3D) a deterministic base layer.
  // The 3D container's positioning is NOT left to the foundation model: a forgetful
  // pass that omits it leaves the canvas as an unpositioned block, so the scene never
  // sits behind the slides. We inject the guaranteed layering LAST in <head> so it
  // wins the cascade over any (wrong) authored rule. No editor marker → kept by
  // getCleanHtml, so exported decks stay self-contained. Slide-background opacity
  // (the other way to occlude the layer) stays the model's call, lint-gated below.
  const fontLinks = fontLinksFor(brief.fonts);
  const headLines = [
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<title>${title}</title>`,
    ...fontLinks,
    '<link rel="stylesheet" href="style.css">',
  ];
  if (uses3D) headLines.push(THREE_LAYER_BASE_CSS);
  const head = headLines.map((l) => "  " + l).join("\n");

  // <body>: optional 3D layer, the presentation, chrome, then scripts in order.
  const scripts: string[] = [];
  if (uses3D) scripts.push('<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>');
  if (usesChart) {
    scripts.push('<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>');
    scripts.push('<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"></script>');
  }
  if (uses3D) scripts.push('<script src="three_scene.js"></script>');
  scripts.push('<script src="script.js"></script>');

  const bodyParts = [
    uses3D ? '<div id="three-canvas-container"><canvas id="three-canvas"></canvas></div>' : "",
    '<main class="presentation">',
    slideHtml,
    "</main>",
    '<div class="aura-follower"></div>',
    '<div class="progress-bar"><div class="progress"></div></div>',
    '<div class="slide-indicator"><span class="current">01</span> / <span class="total">00</span></div>',
    ...scripts,
  ].filter(Boolean);
  const body = bodyParts.join("\n");

  const indexHtml = `<!DOCTYPE html>
<html lang="${lang}">
<head>
${head}
</head>
<body>
${body}
</body>
</html>
`;

  return {
    indexHtml,
    styleCss: foundation.styleCss,
    scriptJs,
    threeSceneJs: uses3D ? foundation.threeSceneJs : undefined,
  };
}

// Map brief font names → CDN <link> tags. Pretendard always; the rest via Google
// Fonts. Best-effort: an unrecognized name is still requested from Google Fonts.
export function fontLinksFor(fonts: string[]): string[] {
  const links: string[] = [
    '<link rel="stylesheet" as="style" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css">',
  ];
  const googleFamilies = new Set<string>();
  for (const raw of fonts || []) {
    const f = raw.trim();
    if (!f || /pretendard/i.test(f) || /system-ui|sans-serif|serif|monospace/i.test(f)) continue;
    googleFamilies.add(f);
  }
  if (googleFamilies.size) {
    const params = Array.from(googleFamilies)
      .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;500;600;700;800;900`)
      .join("&");
    links.push(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${params}&display=swap">`);
  }
  return links;
}

export function buildQaUserText(files: DeckFiles, lintIssues: string[] = []): string {
  const bundle =
    `방금 조립된 덱이다.\n\n=== index.html ===\n${files.indexHtml}\n\n` +
    `=== style.css ===\n${files.styleCss}\n\n` +
    `=== script.js ===\n${files.scriptJs}\n` +
    (files.threeSceneJs ? `\n=== three_scene.js ===\n${files.threeSceneJs}\n` : "");
  const findings = lintIssues.length
    ? `\n\n자동 점검(코드 검사)에서 아래 문제가 감지됐다 — **이것부터 반드시 고쳐라**:\n- ${lintIssues.join("\n- ")}`
    : "";
  return `${bundle}\n\n${QA_CHECKLIST}${findings}`;
}

// --- deterministic lint (gates the QA pass) ---------------------------------
// Zero-token, high-precision pre-check on the ASSEMBLED deck. Each check should
// almost never fire on a healthy editorial deck, so a clean deck skips the paid
// repair. It detects mechanical/contract problems, not rendered failures.
export function deckLint(files: DeckFiles): { issues: string[] } {
  const issues: string[] = [];
  const html = files.indexHtml || "";
  const css = files.styleCss || "";
  const js = files.scriptJs || "";
  const three = files.threeSceneJs || "";
  const all = `${html}\n${css}\n${js}\n${three}`;
  const lower = all.toLowerCase();

  // Leftover placeholders / meta-commentary.
  for (const p of ["lorem ipsum", "lorem", "todo", "fixme", "여기에", "placeholder", "내용을 입력", "[제목]", "[내용]"]) {
    if (lower.includes(p)) {
      issues.push(`플레이스홀더 잔존: "${p}"`);
      break;
    }
  }
  if (/이 슬라이드는|슬라이드는[^.]{0,12}설계/.test(html)) issues.push("슬라이드 내 메타설명 잔존");

  // Editor structure: <main class="presentation"> + .slide units + scroll-snap.
  if (!/class=["'][^"']*\bpresentation\b/.test(html)) issues.push('구조 위반: <main class="presentation"> 없음');
  if (!/class=["'][^"']*\bslide\b/.test(html)) issues.push("구조 위반: .slide 섹션 없음");
  if (!/scroll-snap-type/.test(css)) issues.push("스크롤스냅(scroll-snap-type) 규칙 없음");

  // Korean word-wrap.
  if (!/word-break\s*:\s*keep-all/.test(css)) issues.push("body word-break:keep-all 누락(한국어 줄바꿈 깨짐)");

  // Reveal mechanism: .anim/.reveal/data-animate must be toggled via .in-view.
  if (/\banim\b|data-animate|\breveal\b/.test(html) && !/in-view/.test(js)) {
    issues.push("등장 애니메이션: script.js에 .in-view 토글 로직 없음");
  }

  // Forbidden section-label badges (서론 1 / 본론 4 / 결론 …).
  if (/(서론|본론|결론)\s*\d/.test(html)) issues.push("섹션 뱃지(서론/본론/결론 + 번호) 사용 — 제거해야 함");

  // Fixed-pixel canvas attributes squish charts (the exact bug in the bad deck).
  if (/<canvas[^>]*\b(width|height)\s*=/i.test(html)) issues.push("캔버스에 고정 width/height 속성 — 찌그러짐 위험(CSS로 크기 지정해야 함)");

  // Chart.js datalabels contract (only when charts are actually used).
  const usesChart = /new\s+Chart\s*\(/.test(js) || /__chartInit/.test(js) || /chart\.js/i.test(html);
  if (usesChart) {
    if (!/chartjs-plugin-datalabels/i.test(html)) issues.push("Chart 사용 중 chartjs-plugin-datalabels CDN 누락");
    if (!/Chart\.register\s*\(\s*ChartDataLabels/.test(js)) issues.push("Chart.register(ChartDataLabels) 호출 누락");
  }

  // Canvas ↔ __chartInit parity (excludes the 3D canvas): a chart canvas with no
  // registration renders blank — the exact kind of breakage manual review catches.
  const canvasIds = Array.from(html.matchAll(/<canvas[^>]*\bid=["']([^"']+)["']/gi))
    .map((mm) => mm[1])
    .filter((id) => id !== "three-canvas");
  for (const id of canvasIds) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`__chartInit\\s*[\\[.]\\s*["']?${esc}["']?`).test(js)) {
      issues.push(`차트 캔버스 #${id} 에 대응하는 window.__chartInit 등록이 없음(빈 차트로 렌더됨)`);
    }
  }

  // Too few slides → the generation was almost certainly truncated/broken (a real
  // editorial deck has many sections). High precision: never fires on a healthy deck.
  const slideCount = (html.match(/<section[^>]*\bslide\b/gi) || []).length;
  if (slideCount > 0 && slideCount < 4) issues.push(`슬라이드가 ${slideCount}장뿐 — 생성이 잘렸거나 깨졌을 수 있음`);

  // High-signal banned filler words (a precise subset of the §카피 규칙). These
  // almost never appear except as AI boilerplate, so flagging them is safe.
  for (const w of ["시사점", "패러다임", "재정의", "진정성"]) {
    if (html.includes(w)) {
      issues.push(`금지어(카피 규칙) 사용: "${w}" — 쉬운 말로 바꿔라`);
      break;
    }
  }

  // Print / headless contract.
  if (!/@media\s+print/.test(css)) issues.push("@media print 블록 없음");
  if (!/@page/.test(css)) issues.push("@page 사이즈 규칙 없음");
  if (!/HeadlessChrome/.test(js)) issues.push("Headless 1프레임 안전처리(HeadlessChrome 감지) 없음");
  if (!/beforeprint/.test(js)) issues.push("beforeprint 처리 없음");

  // External http image refs — the editor can't resolve them.
  if (/<img[^>]+src=["']https?:\/\//i.test(html)) issues.push("외부 http 이미지 참조(에디터가 못 푸는 경로)");

  // 3D scene contract: #three-canvas-container wrapper + __htmlPptScene hook.
  // Only treat the deck as 3D when there's an actual Three.js asset/canvas — not
  // a stray "THREE." / "three-canvas" substring in copy (avoids false positives
  // on non-3D decks, which would trigger needless QA).
  const usesThree = !!three || /three(\.min)?\.js/i.test(html) || /id=["']three-canvas\b/i.test(html);
  if (usesThree) {
    if (!/three-canvas-container/.test(html)) issues.push("3D 캔버스가 #three-canvas-container로 감싸지지 않음(에디터 선택 불가)");
    if (/window\.threeScene\b/.test(all)) issues.push("잘못된 씬 컨트롤러 이름 window.threeScene (window.__htmlPptScene 사용해야 함)");
    if (!/window\.__htmlPptScene\b/.test(all)) issues.push("3D인데 window.__htmlPptScene 컨트롤러 노출 없음");
    // The 3D layer sits behind the slides (z-index:0, assembler-injected). If slides
    // paint an opaque full-bleed background and the CSS shows no translucency anywhere,
    // the scene is fully occluded — the "3D isn't overlaid" bug. High precision: a real
    // 3D editorial deck almost always uses transparent/rgba/hsla somewhere. Routes to QA
    // to make the slide/body backgrounds let the scene through.
    const slideHasOpaqueBg = /\.slide\b[^{]*\{[^}]*\bbackground(-color)?\s*:\s*(#|var\(|rgb\(|hsl\(|white|ivory|black|beige)/i.test(css);
    const allowsThrough = /transparent|rgba\(|hsla\(/i.test(css);
    if (slideHasOpaqueBg && !allowsThrough) {
      issues.push("3D 레이어가 불투명 슬라이드 배경에 가려짐 — body/슬라이드 배경을 투명·반투명(transparent/rgba)으로 해서 3D가 보이게 하라");
    }
  }

  return { issues };
}

export function mergeQaFixes(base: DeckFiles, rawFixed: unknown): { files: DeckFiles; changed: boolean } {
  if (!rawFixed || typeof rawFixed !== "object") return { files: base, changed: false };
  const f = rawFixed as Record<string, unknown>;
  const next: DeckFiles = { ...base };
  let changed = false;
  const apply = (key: "indexHtml" | "styleCss" | "scriptJs" | "threeSceneJs", val: unknown) => {
    if (typeof val === "string" && val.trim() && val !== base[key]) {
      next[key] = val;
      changed = true;
    }
  };
  apply("indexHtml", f.indexHtml);
  apply("styleCss", f.styleCss);
  apply("scriptJs", f.scriptJs);
  apply("threeSceneJs", f.threeSceneJs);
  return { files: next, changed };
}

export function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));
}
