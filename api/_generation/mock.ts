// Offline mock deck generator — used when no provider key is configured (or
// HTML_PPT_AI_MOCK forces it), so the whole New-AI-Deck flow works secret-free.
// Produces a small, valid, editor-contract-compliant editorial deck.

import type { GenerationRequest, GeneratedDeck } from "../../shared/generation";
import { escapeHtml } from "./assemble";

export function mockDeck(deckId: string, req: GenerationRequest): GeneratedDeck {
  const topic = req.topic;
  const slides = [
    { eyebrow: "Overview", title: topic, body: "데모 모드로 생성된 예시 덱입니다. ANTHROPIC_API_KEY 또는 OPENAI_API_KEY를 설정하면 실제 AI가 만듭니다" },
    { eyebrow: "Context", title: "지금 무엇이 문제인가", body: "상황을 한 줄로 정의하고, 핵심 수치를 슬로건보다 앞에 둡니다" },
    { eyebrow: "Finding", title: "우리가 발견한 것", body: "근거가 되는 데이터와 관찰을 제시합니다" },
    { eyebrow: "Action", title: "그래서 무엇을 한다", body: "구체적인 실행 항목을 제안합니다" },
    { eyebrow: "Close", title: "기대 효과", body: "결과로 무엇이 달라지는지 짚습니다" },
  ];
  const sections = slides.map((s) => s.title);

  const indexHtml = `<!DOCTYPE html>
<html lang="${req.language === "en" ? "en" : "ko"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(topic)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<main class="presentation">
${slides
  .map(
    (s, i) => `  <section class="slide" data-index="${i}">
    <header class="slide-header"><span class="chapter-ko">${escapeHtml(s.eyebrow)}</span><span class="page">${String(i + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}</span></header>
    <div class="slide__body">
      <h1 class="title anim anim-1">${escapeHtml(s.title)}</h1>
      <p class="body anim anim-2">${escapeHtml(s.body)}</p>
    </div>
    <footer class="slide-footer"><span>${escapeHtml(topic)}</span><span class="src">데모</span></footer>
  </section>`
  )
  .join("\n")}
</main>
<script src="script.js"></script>
</body>
</html>
`;

  const styleCss = `:root{--bg:#FAF8F3;--ink:#1A1A1A;--sub:#5A554C;--accent:#B0852F;--line:#E3DDD0;
  --fs-hero:clamp(40px,6vw,96px);--fs-body:clamp(18px,1.6vw,28px);--ease:cubic-bezier(.22,1,.36,1);}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--ink);font-family:"Pretendard",system-ui,sans-serif;word-break:keep-all;overflow-wrap:break-word;}
.presentation{scroll-snap-type:y mandatory;overflow-y:auto;height:100vh;}
.slide{position:relative;height:100vh;scroll-snap-align:start;display:flex;flex-direction:column;justify-content:center;padding:8vh 9vw;border-bottom:1px solid var(--line);}
.slide-header,.slide-footer{position:absolute;left:9vw;right:9vw;display:flex;justify-content:space-between;font-size:14px;letter-spacing:.08em;color:var(--sub);text-transform:uppercase;}
.slide-header{top:6vh;}
.slide-footer{bottom:6vh;}
.chapter-ko{font-style:italic;color:var(--accent);}
.title{font-size:var(--fs-hero);line-height:1.05;font-weight:800;max-width:18ch;}
.body{font-size:var(--fs-body);color:var(--sub);margin-top:1.2em;max-width:46ch;}
.anim{opacity:0;transform:translateY(24px);transition:opacity .7s var(--ease),transform .7s var(--ease);}
.slide.in-view .anim{opacity:1;transform:none;}
.slide.in-view .anim-2{transition-delay:.12s;}
@media print{
  @page{size:1920px 1080px;margin:0;}
  .slide{width:1920px!important;height:1080px!important;overflow:hidden;page-break-after:always;}
  .anim{opacity:1!important;transform:none!important;}
  *{print-color-adjust:exact!important;}
}
`;

  const scriptJs = `(function(){
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  function reveal(){ slides.forEach(function(s){ s.classList.add('in-view'); }); }
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in-view'); } });
  }, { threshold: 0.4 });
  slides.forEach(function(s){ io.observe(s); });
  if (navigator.userAgent.indexOf('HeadlessChrome') !== -1) { setTimeout(reveal, 200); }
  addEventListener('beforeprint', reveal);
  addEventListener('keydown', function(ev){
    var i = slides.findIndex(function(s){ var r=s.getBoundingClientRect(); return r.top>=-2 && r.top< window.innerHeight*0.5; });
    if (i < 0) i = 0;
    if (['ArrowDown','PageDown',' '].indexOf(ev.key)!==-1 && slides[i+1]){ ev.preventDefault(); slides[i+1].scrollIntoView({behavior:'smooth'}); }
    if (['ArrowUp','PageUp'].indexOf(ev.key)!==-1 && slides[i-1]){ ev.preventDefault(); slides[i-1].scrollIntoView({behavior:'smooth'}); }
  });
})();
`;

  return {
    deckId,
    files: { indexHtml, styleCss, scriptJs },
    brief: {
      topic,
      presetUsed: req.preset === "auto" ? "light-editorial" : req.preset,
      paletteHex: ["#FAF8F3", "#1A1A1A", "#B0852F"],
      fonts: ["Pretendard", "Noto Serif KR"],
      sections,
      threeDMotif: "none",
      language: req.language === "en" ? "en" : "ko",
      toneNotes: "Demo deck — editorial light preset; declarative titles, quantitative-first body.",
    },
    message: "Demo mode — generated a starter deck (no real AI; set ANTHROPIC_API_KEY or OPENAI_API_KEY to generate).",
    mock: true,
  };
}
