// Anthropic/OpenAI tool-use schemas (standard JSON Schema → near drop-in
// input_schema) + the coercion helpers that normalize raw tool_use.input back
// into the typed shapes in ./types. Forced tool use is the structured-output
// mechanism; the model fills these. Server + client both import from here.

import type {
  DeckFiles,
  DesignBrief,
  DeckPlan,
  SlidePlan,
  FoundationResult,
  ComponentManifestEntry,
  SlideHtml,
  CandidateResult,
} from "./types";
import type { PersonaProfile, PersonaInterviewState } from "./wizard";

const FILES_PROPS = {
  indexHtml: { type: "string", description: "Complete index.html (links style.css, script.js, three_scene.js when used)." },
  styleCss: { type: "string", description: "Complete style.css." },
  scriptJs: { type: "string", description: "Complete script.js (vanilla ES6)." },
  threeSceneJs: { type: "string", description: "three_scene.js — ONLY when the deck uses a 3D/canvas background; omit otherwise." },
} as const;

const BRIEF_PROPS = {
  topic: { type: "string" },
  presetUsed: { type: "string", description: "Which preset/palette family was used." },
  paletteHex: { type: "array", items: { type: "string" }, description: "Key palette colors as #RRGGBB." },
  fonts: { type: "array", items: { type: "string" } },
  sections: { type: "array", items: { type: "string" }, description: "Ordered slide-section titles." },
  threeDMotif: { type: "string", description: "The 3D motif used, or \"none\"." },
  language: { type: "string" },
  toneNotes: { type: "string", description: "One or two lines on the copy voice + design intent." },
} as const;

export const EMIT_DECK_TOOL = "emit_deck";

export const EMIT_DECK_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "object",
      properties: FILES_PROPS,
      required: ["indexHtml", "styleCss", "scriptJs"],
      additionalProperties: false,
    },
    designBrief: {
      type: "object",
      properties: BRIEF_PROPS,
      required: ["topic", "presetUsed", "paletteHex", "fonts", "sections", "threeDMotif", "language", "toneNotes"],
      additionalProperties: false,
    },
    message: { type: "string", description: "One short sentence for the user about what was built." },
  },
  required: ["files", "designBrief", "message"],
  additionalProperties: false,
} as const;

export const EMIT_QA_TOOL = "emit_qa_fixes";

// The self-check pass returns issues + ONLY the files it actually changed
// (token-lean). Every file is optional; merge over the first-pass deck.
export const QA_SCHEMA = {
  type: "object",
  properties: {
    issues: { type: "array", items: { type: "string" }, description: "Problems found (banned words, overflow risk, placeholder leftovers, missing sources, broken 3D contract). Empty if clean." },
    files: {
      type: "object",
      properties: FILES_PROPS,
      additionalProperties: false,
      description: "Corrected full contents for ONLY the files that changed. Omit unchanged files.",
    },
  },
  required: ["issues", "files"],
  additionalProperties: false,
} as const;

// Validate / normalize a raw tool_use.input into DeckFiles (server + client use this).
export function coerceDeckFiles(raw: unknown): DeckFiles | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  const indexHtml = str(f.indexHtml);
  const styleCss = str(f.styleCss);
  const scriptJs = str(f.scriptJs);
  if (!indexHtml) return null; // index.html is the only hard requirement
  return {
    indexHtml,
    styleCss: styleCss ?? "",
    scriptJs: scriptJs ?? "",
    threeSceneJs: str(f.threeSceneJs),
  };
}

// ---- delimited single-pass output -----------------------------------------
// The single-pass model emits the deck as delimited free-text files instead of one
// structured-output JSON object. The win: a TRUNCATED response stays usable — every
// file that completed is kept, and a partial index.html (written last, slides in
// order) just yields a shorter but still-renderable deck. This is what makes the
// single coherent-author path safe to retry/continue instead of losing everything.

// Strip a surrounding ```lang … ``` fence (or a dangling opening/closing one).
function stripFences(s: string): string {
  let t = s.trim();
  const full = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(t);
  if (full) return full[1];
  t = t.replace(/^```[\w-]*[ \t]*\r?\n/, "");
  t = t.replace(/\r?\n```\s*$/, "");
  return t;
}

// Best-effort close of tags a truncation left open so a partial deck still renders.
function repairTruncatedHtml(html: string): string {
  let h = html.trimEnd();
  const open = (h.match(/<section\b/gi) || []).length;
  const close = (h.match(/<\/section>/gi) || []).length;
  for (let i = close; i < open; i++) h += "\n</section>";
  if (/<main\b/i.test(h) && !/<\/main>/i.test(h)) h += "\n</main>";
  if (/<body\b/i.test(h) && !/<\/body>/i.test(h)) h += "\n</body>";
  if (/<html\b/i.test(h) && !/<\/html>/i.test(h)) h += "\n</html>";
  return h;
}

// Salvage a raw HTML document when the model skipped the markers entirely.
function extractLooseHtml(text: string): string {
  const i = text.search(/<!DOCTYPE html|<html[\s>]/i);
  if (i === -1) return "";
  const h = stripFences(text.slice(i));
  return /<section[^>]*\bslide\b/i.test(h) ? repairTruncatedHtml(h) : "";
}

export interface ParsedDelimitedDeck {
  files: DeckFiles | null;
  brief: unknown;
  message: string;
  /** true once the END sentinel was seen — i.e. the output wasn't truncated. */
  complete: boolean;
}

// Parse the delimited single-pass output into DeckFiles + brief. Tolerant by design:
// keeps whatever completed, repairs a truncated trailing index.html, returns
// files:null only when there is no usable index.html yet (→ caller continues or falls back).
export function parseDelimitedDeck(raw: string): ParsedDelimitedDeck {
  const text = typeof raw === "string" ? raw : "";
  const complete = /^[ \t]*={2,}[ \t]*END[ \t]*={2,}[ \t]*$/im.test(text);

  const markerRe = /^[ \t]*={2,}[ \t]*(FILE:[ \t]*[\w.\-]+|BRIEF|MESSAGE|END)[ \t]*={2,}[ \t]*$/gim;
  const marks: { name: string; bodyStart: number; markStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text)) !== null) {
    marks.push({ name: m[1].trim(), bodyStart: markerRe.lastIndex, markStart: m.index });
  }
  if (!marks.length) {
    const html = extractLooseHtml(text);
    return { files: html ? { indexHtml: html, styleCss: "", scriptJs: "" } : null, brief: {}, message: "", complete };
  }

  const bodyOf = (i: number): string => {
    const end = i + 1 < marks.length ? marks[i + 1].markStart : text.length;
    return text.slice(marks[i].bodyStart, end).replace(/^\r?\n/, "");
  };

  let indexHtml = "";
  let styleCss = "";
  let scriptJs = "";
  let threeSceneJs = "";
  let message = "";
  let brief: unknown = {};
  for (let i = 0; i < marks.length; i++) {
    const name = marks[i].name.toUpperCase();
    const body = bodyOf(i);
    if (name.startsWith("FILE:")) {
      const file = name.slice(5).trim().toLowerCase();
      if (file === "index.html") indexHtml = stripFences(body);
      else if (file === "style.css") styleCss = stripFences(body);
      else if (file === "script.js") scriptJs = stripFences(body);
      else if (file === "three_scene.js") threeSceneJs = stripFences(body);
    } else if (name === "BRIEF") {
      try {
        brief = JSON.parse(stripFences(body));
      } catch {
        brief = {};
      }
    } else if (name === "MESSAGE") {
      message = body.trim();
    }
  }

  if (!indexHtml || !/<section[^>]*\bslide\b/i.test(indexHtml)) {
    return { files: null, brief, message, complete };
  }
  indexHtml = repairTruncatedHtml(indexHtml);
  return {
    files: { indexHtml, styleCss, scriptJs, threeSceneJs: threeSceneJs || undefined },
    brief,
    message,
    complete,
  };
}

// ---- multi-pass tool names ------------------------------------------------

export const EMIT_PLAN_TOOL = "emit_plan";
export const EMIT_FOUNDATION_TOOL = "emit_foundation";
export const EMIT_SLIDES_TOOL = "emit_slides";

// ---- multi-pass schemas ---------------------------------------------------

const SLIDE_PLAN_PROPS = {
  index: { type: "integer", description: "0-based slide order." },
  kind: { type: "string", description: "Editorial component kind for this slide (cover, contents, divider, content-2col, stat-strip, kpi, scq, flow, bar-chart, doughnut-chart, quote, callout, node-cards, mega-number, transition, refs, close, ...). Vary it — never repeat the same component back-to-back." },
  sectionNo: { type: "string", description: 'Section/chapter number like "01" or "01—1".' },
  eyebrowKo: { type: "string", description: "Korean chapter label for the slide-header." },
  eyebrowEn: { type: "string", description: "English italic eyebrow for the slide-header." },
  title: { type: "string", description: "The one core message of the slide (declarative, never a question)." },
  subtitle: { type: "string" },
  bullets: { type: "array", items: { type: "string" } },
  stats: {
    type: "array",
    items: {
      type: "object",
      properties: {
        value: { type: "string" },
        unit: { type: "string" },
        label: { type: "string" },
        note: { type: "string" },
      },
      required: ["value", "label"],
      additionalProperties: false,
    },
  },
  chart: {
    type: "object",
    properties: {
      canvasId: { type: "string", description: "Unique canvas id (e.g. financeChart)." },
      type: { type: "string", description: "Chart.js type: bar | line | doughnut | radar | ..." },
      labels: { type: "array", items: { type: "string" } },
      series: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, data: { type: "array", items: { type: "number" } } },
          required: ["label", "data"],
          additionalProperties: false,
        },
      },
      note: { type: "string" },
      source: { type: "string" },
    },
    required: ["canvasId", "type", "labels", "series"],
    additionalProperties: false,
  },
  quote: {
    type: "object",
    properties: { text: { type: "string" }, cite: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  source: { type: "string", description: "Source for any figures on this slide, or empty." },
  notes: { type: "string", description: "Design/layout note for pass 3." },
} as const;

export const EMIT_PLAN_SCHEMA = {
  type: "object",
  properties: {
    designBrief: {
      type: "object",
      properties: BRIEF_PROPS,
      required: ["topic", "presetUsed", "paletteHex", "fonts", "sections", "threeDMotif", "language", "toneNotes"],
      additionalProperties: false,
    },
    slides: {
      type: "array",
      description: "The full slide-by-slide outline in order (cover → contents → [divider → body → transition] × N → refs → close). Aim for 32–45 slides unless length says otherwise.",
      items: { type: "object", properties: SLIDE_PLAN_PROPS, required: ["index", "kind", "title"], additionalProperties: false },
    },
    message: { type: "string", description: "One short sentence on the planned deck." },
  },
  required: ["designBrief", "slides", "message"],
  additionalProperties: false,
} as const;

export const EMIT_FOUNDATION_SCHEMA = {
  type: "object",
  properties: {
    styleCss: { type: "string", description: "Complete style.css: tokens for the chosen preset + CSS for EVERY component kind used by the plan + .slide/.presentation/.anim/print rules." },
    scriptJs: { type: "string", description: "Complete script.js: IntersectionObserver .in-view toggle, keyboard nav, chart dispatcher that calls window.__chartInit[canvasId](canvas) on reveal, and print/headless initAll. Do NOT inline chart data here." },
    threeSceneJs: { type: "string", description: "three_scene.js — ONLY when the deck uses a 3D background; omit otherwise. Must expose window.__htmlPptScene." },
    componentManifest: {
      type: "array",
      description: "One entry per component class the CSS defines, with a tiny HTML example. Pass 3 copies these structures verbatim.",
      items: {
        type: "object",
        properties: {
          className: { type: "string" },
          usage: { type: "string" },
          exampleHtml: { type: "string" },
        },
        required: ["className", "usage", "exampleHtml"],
        additionalProperties: false,
      },
    },
  },
  required: ["styleCss", "scriptJs", "componentManifest"],
  additionalProperties: false,
} as const;

export const EMIT_SLIDES_SCHEMA = {
  type: "object",
  properties: {
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Matches the plan slide index." },
          html: { type: "string", description: "Complete <section class=\"slide ...\">…</section> markup using the component manifest classes, with per-slide header/footer." },
          chartInitJs: { type: "string", description: "Optional JS: window.__chartInit['canvasId'] = function(canvas){ new Chart(canvas.getContext('2d'), {…}); }; — include for every canvas on the slide." },
        },
        required: ["index", "html"],
        additionalProperties: false,
      },
    },
  },
  required: ["slides"],
  additionalProperties: false,
} as const;

// ---- coercion -------------------------------------------------------------

const asStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function coercePlan(raw: unknown): DeckPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawSlides = Array.isArray(r.slides) ? r.slides : [];
  const slides: SlidePlan[] = rawSlides
    .map((s, i): SlidePlan | null => {
      if (!s || typeof s !== "object") return null;
      const o = s as Record<string, unknown>;
      const title = asStr(o.title);
      const kind = asStr(o.kind) ?? "content-2col";
      const index = typeof o.index === "number" && Number.isFinite(o.index) ? o.index : i;
      const out: SlidePlan = { index, kind };
      if (title) out.title = title;
      const assignStr = (k: keyof SlidePlan, v: unknown) => { const x = asStr(v); if (x) (out as unknown as Record<string, unknown>)[k] = x; };
      assignStr("sectionNo", o.sectionNo);
      assignStr("eyebrowKo", o.eyebrowKo);
      assignStr("eyebrowEn", o.eyebrowEn);
      assignStr("subtitle", o.subtitle);
      assignStr("source", o.source);
      assignStr("notes", o.notes);
      if (Array.isArray(o.bullets)) out.bullets = asStrArr(o.bullets);
      if (Array.isArray(o.stats)) {
        out.stats = (o.stats as unknown[])
          .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
          .filter((x): x is Record<string, unknown> => !!x && !!asStr(x.value) && !!asStr(x.label))
          .map((x) => ({ value: asStr(x.value)!, label: asStr(x.label)!, unit: asStr(x.unit), note: asStr(x.note) }));
      }
      if (o.chart && typeof o.chart === "object") {
        const c = o.chart as Record<string, unknown>;
        const canvasId = asStr(c.canvasId);
        const type = asStr(c.type);
        if (canvasId && type) {
          const series = Array.isArray(c.series)
            ? (c.series as unknown[])
                .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
                .filter((x): x is Record<string, unknown> => !!x)
                .map((x) => ({ label: asStr(x.label) ?? "", data: Array.isArray(x.data) ? (x.data as unknown[]).filter((n): n is number => typeof n === "number") : [] }))
            : [];
          out.chart = { canvasId, type, labels: asStrArr(c.labels), series, note: asStr(c.note), source: asStr(c.source) };
        }
      }
      if (o.quote && typeof o.quote === "object") {
        const q = o.quote as Record<string, unknown>;
        const text = asStr(q.text);
        if (text) out.quote = { text, cite: asStr(q.cite) };
      }
      return out;
    })
    .filter((s): s is SlidePlan => !!s);
  if (!slides.length) return null;
  // Normalize indices to a contiguous 0..n-1 order.
  slides.sort((a, b) => a.index - b.index).forEach((s, i) => { s.index = i; });
  const brief = coerceBriefShape(r.designBrief);
  return { brief, slides };
}

// Shared brief coercion (also used by the generator without the request fallback).
function coerceBriefShape(raw: unknown): DesignBrief {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    topic: asStr(r.topic) ?? "",
    presetUsed: asStr(r.presetUsed) ?? "",
    paletteHex: asStrArr(r.paletteHex),
    fonts: asStrArr(r.fonts),
    sections: asStrArr(r.sections),
    threeDMotif: asStr(r.threeDMotif) ?? "",
    language: asStr(r.language) ?? "",
    toneNotes: asStr(r.toneNotes) ?? "",
  };
}

export function coerceFoundation(raw: unknown): FoundationResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const styleCss = asStr(r.styleCss);
  const scriptJs = asStr(r.scriptJs);
  if (!styleCss || !scriptJs) return null;
  const manifest: ComponentManifestEntry[] = Array.isArray(r.componentManifest)
    ? (r.componentManifest as unknown[])
        .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
        .filter((x): x is Record<string, unknown> => !!x && !!asStr(x.className))
        .map((x) => ({ className: asStr(x.className)!, usage: asStr(x.usage) ?? "", exampleHtml: asStr(x.exampleHtml) ?? "" }))
    : [];
  return { styleCss, scriptJs, threeSceneJs: asStr(r.threeSceneJs), componentManifest: manifest };
}

export function coerceSlides(raw: unknown): SlideHtml[] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = Array.isArray(r.slides) ? r.slides : Array.isArray(raw) ? (raw as unknown[]) : [];
  return arr
    .map((s): SlideHtml | null => {
      if (!s || typeof s !== "object") return null;
      const o = s as Record<string, unknown>;
      const html = asStr(o.html);
      if (!html) return null;
      const index = typeof o.index === "number" && Number.isFinite(o.index) ? o.index : 0;
      return { index, html, chartInitJs: asStr(o.chartInitJs) };
    })
    .filter((s): s is SlideHtml => !!s);
}

// ---- candidate preview schema ---------------------------------------------

export const EMIT_CANDIDATE_TOOL = "emit_candidate";

// One candidate = a single self-contained hero/title slide + its style.css + a
// compact brief. The HTML must be a COMPLETE standalone document (inline or
// linked CSS embedded) so it renders directly in a preview iframe.
export const EMIT_CANDIDATE_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", description: "Short label for this visual direction, e.g. \"Warm editorial\"." },
    html: {
      type: "string",
      description:
        "A COMPLETE standalone HTML document for ONE representative hero/title slide (full <html>…</html> with the CSS inlined in a <style> tag), 1920×1080 aspect, no external JS required. This is a visual sample of the deck's look.",
    },
    css: { type: "string", description: "The style.css this direction would use for the full deck (token + base rules)." },
    designBrief: {
      type: "object",
      properties: BRIEF_PROPS,
      required: ["topic", "presetUsed", "paletteHex", "fonts", "sections", "threeDMotif", "language", "toneNotes"],
      additionalProperties: false,
    },
  },
  required: ["label", "html", "css", "designBrief"],
  additionalProperties: false,
} as const;

export function coerceCandidate(raw: unknown, candidateId: string): CandidateResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const html = asStr(r.html);
  if (!html) return null;
  return {
    candidateId,
    label: asStr(r.label) ?? "Variant",
    html,
    css: asStr(r.css) ?? "",
    brief: coerceBriefShape(r.designBrief),
  };
}

// ---- persona interview schema ---------------------------------------------

export const PERSONA_TOOL = "persona_step";

// Either the next question (still gathering) or the final profile (done:true).
export const PERSONA_SCHEMA = {
  type: "object",
  properties: {
    done: { type: "boolean", description: "true when enough is known to write the profile; false to ask one more question." },
    nextQuestion: { type: "string", description: "When done=false: ONE short, friendly question to learn the user's taste. Empty when done." },
    profile: {
      type: "object",
      description: "When done=true: the distilled persona/taste profile.",
      properties: {
        profileText: { type: "string", description: "2–4 sentences describing the user's style preferences (mood, color temperature, density, formality, motifs)." },
        referenceNote: { type: "string", description: "One line on any design DNA from the user's references, or empty." },
      },
      required: ["profileText"],
      additionalProperties: false,
    },
  },
  required: ["done"],
  additionalProperties: false,
} as const;

export function coercePersonaStep(raw: unknown): PersonaInterviewState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const done = r.done === true;
  if (done) {
    const p = (r.profile && typeof r.profile === "object" ? r.profile : {}) as Record<string, unknown>;
    const profile: PersonaProfile = { profileText: asStr(p.profileText) ?? "", referenceNote: asStr(p.referenceNote) };
    return { history: [], done: true, profile };
  }
  const nextQuestion = asStr(r.nextQuestion);
  if (!nextQuestion) return null;
  return { history: [], done: false, nextQuestion };
}

// ---- 3D scene regeneration schema -----------------------------------------

export const EMIT_SCENE_TOOL = "emit_scene";

export const EMIT_SCENE_SCHEMA = {
  type: "object",
  properties: {
    threeSceneJs: {
      type: "string",
      description:
        "Complete three_scene.js for a brand-new 3D/canvas background animation. Uses the global THREE (loaded via CDN), renders into <canvas id=\"three-canvas\"> inside #three-canvas-container, self-initializes on load, handles resize, and exposes window.__htmlPptScene = { getParams(), setParam(key,value) } supporting spinSpeed, particleOpacity, keyLightColor, fillLightColor, brightness. No imports/exports — global script only.",
    },
    threeDMotif: { type: "string", description: "Short label for the new motif, e.g. \"flowing ribbons\"." },
    message: { type: "string", description: "One short sentence for the user about the new animation." },
  },
  required: ["threeSceneJs", "threeDMotif", "message"],
  additionalProperties: false,
} as const;

export function coerceSceneResult(raw: unknown): { threeSceneJs: string; threeDMotif: string; message: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const threeSceneJs = asStr(r.threeSceneJs);
  if (!threeSceneJs) return null;
  return {
    threeSceneJs,
    threeDMotif: asStr(r.threeDMotif) ?? "custom 3D background",
    message: asStr(r.message) ?? "Regenerated the 3D background animation.",
  };
}

// One AI-authored slide inserted between existing ones (Phase 3 slide management).
// Static only — no <script>/Chart.js (those need wiring the inserter can't do); the
// editor sanitizes the html before it touches the DOM.
export const EMIT_SLIDE_TOOL = "emit_slide";

export const EMIT_SLIDE_SCHEMA = {
  type: "object",
  properties: {
    html: {
      type: "string",
      description:
        "ONE complete <section class=\"slide\">…</section> element. Reuse the deck's existing component classes (from the neighbour slides shown). Reveal animations: put class \"anim\" (and anim-2/anim-3 for stagger) on the elements that should fade in. NO <script>, NO <canvas>, NO Chart.js — use inline SVG or CSS for any chart/visual. NO inline on* handlers. Keep it to one screen (100vh).",
    },
    title: { type: "string", description: "Short title of the new slide." },
    message: { type: "string", description: "One short sentence for the user about the inserted slide." },
  },
  required: ["html", "title", "message"],
  additionalProperties: false,
} as const;

export function coerceSlideResult(raw: unknown): { html: string; title: string; message: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const html = asStr(r.html);
  if (!html) return null;
  return {
    html,
    title: asStr(r.title) ?? "New slide",
    message: asStr(r.message) ?? "Inserted a new slide.",
  };
}
