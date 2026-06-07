// Chart-type control — the editor's one capability that reaches into a deck's
// Chart.js charts. The AI/Inspector can change a chart's TYPE (bar/line/pie/…) by
// picking from a vetted menu (shared/editing/chart.ts); this module reads the LIVE
// Chart instance via the deck's standard `window.Chart` global (Chart.getChart),
// then recreates it with the new type, PRESERVING the chart's data + options. No
// deck contract is needed — any deck using the standard Chart.js global works.
//
// Imports nothing from core (leaf module), so core can import it freely.
//
// PERSISTENCE. A chart's type lives in deck JS, not in element innerHTML/inline
// style, so a live recreate alone wouldn't survive export / session-restore (the
// deck's script.js still has the original type and re-inits to it). To persist,
// we mirror the animation/blocks/scene "kept seam" pattern: record the chosen type
// on the canvas as a `data-chart-type` attribute (NOT a data-html-ppt-* name, so
// cleanHtml keeps it) and inject a kept <script id="html-ppt-chart-overrides">
// (no editor marker → kept by cleanHtml) that, on the NEXT load, wraps each
// window.__chartInit[id] so after the deck builds the original chart it re-applies
// the saved type. So export / reload reproduce the chosen types from the deck's
// own data. (Still OUTSIDE the innerHTML undo stack — like scene params.)
//
// The trust model is unchanged: the caller only ever supplies a whitelisted type.

import type { ChartType } from "@shared/editing";

// The canvas attribute that records the user's chosen type, and the kept re-apply
// script. The attribute name is deliberately NOT data-html-ppt-* so cleanHtml
// keeps it; the script id carries no editor marker so cleanHtml keeps it too.
const CHART_TYPE_ATTR = "data-chart-type";
const CHART_OVERRIDE_SCRIPT_ID = "html-ppt-chart-overrides";

// Minimal structural view of the bits of a Chart.js instance/ctor we touch — we
// don't depend on the chart.js types package (the deck loads it via CDN).
interface ChartDataLike {
  labels?: unknown;
  datasets?: Array<Record<string, unknown>>;
}
interface ChartLike {
  config?: { type?: string; data?: ChartDataLike; options?: unknown };
  data?: ChartDataLike;
  options?: unknown;
  destroy?: () => void;
}
interface ChartCtor {
  new (ctx: CanvasRenderingContext2D, cfg: unknown): ChartLike;
  getChart?: (canvas: HTMLCanvasElement) => ChartLike | undefined;
}

function chartLib(): ChartCtor | null {
  const C = (window as unknown as { Chart?: ChartCtor }).Chart;
  return typeof C === "function" ? C : null;
}

// The canvas for a selected chart: the element itself if it's a <canvas>, else
// the first <canvas> it contains (the user may have selected a chart container).
function canvasFor(host: Element): HTMLCanvasElement | null {
  if (host instanceof HTMLCanvasElement) return host;
  return host.querySelector("canvas");
}

/**
 * Change the type of the Chart.js chart on/under `host`. Returns false (no-op)
 * when there's no canvas, no Chart.js global, or no live instance — so a deck
 * without a recognizable chart is simply left untouched.
 */
export function applyChartTypeToElement(host: Element, chartType: ChartType): boolean {
  const C = chartLib();
  if (!C || typeof C.getChart !== "function") return false;
  const canvas = canvasFor(host);
  if (!canvas) return false;
  const existing = C.getChart(canvas);
  if (!existing) return false;

  // Hold the data + options references BEFORE destroying the old instance.
  const data = existing.config?.data ?? existing.data;
  const options = existing.config?.options ?? existing.options;
  // Clear per-dataset `type` overrides so the new top-level type actually shows
  // even on a mixed (e.g. bar + line) chart.
  if (data && Array.isArray(data.datasets)) {
    for (const ds of data.datasets) {
      if (ds && typeof ds === "object") delete ds.type;
    }
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  let ok = false;
  try {
    existing.destroy?.();
  } catch {
    /* ignore — proceed to recreate on the same canvas */
  }
  try {
    new C(ctx, { type: chartType, data, options });
    ok = true;
  } catch {
    // The preserved options can be incompatible with the new type (e.g. cartesian
    // x/y scales on a radial pie/doughnut) — fall back to data-only so the switch
    // still succeeds with default options for the new type.
    try {
      new C(ctx, { type: chartType, data });
      ok = true;
    } catch {
      ok = false;
    }
  }
  // Persist the choice so it survives export / session-restore (see header note).
  if (ok) persistChartType(canvas, chartType);
  return ok;
}

// Record the chosen type on the canvas and ensure the kept re-apply script is in
// the deck, so the change reproduces on the next load from the deck's own data.
function persistChartType(canvas: HTMLCanvasElement, chartType: ChartType): void {
  canvas.setAttribute(CHART_TYPE_ATTR, chartType);
  ensureChartOverrideScript();
}

// Inject the kept re-apply script once (idempotent). It carries no editor marker
// and a non-data-html-ppt id, so cleanHtml keeps it in the exported deck. Appended
// to <body> so on the next load it runs after the deck's own script.js.
function ensureChartOverrideScript(): void {
  if (document.getElementById(CHART_OVERRIDE_SCRIPT_ID)) return;
  const script = document.createElement("script");
  script.id = CHART_OVERRIDE_SCRIPT_ID;
  script.textContent = CHART_OVERRIDE_SOURCE;
  (document.body || document.documentElement).appendChild(script);
}

// The re-apply logic, as a self-contained IIFE string injected into the deck. On
// load it (1) wraps every window.__chartInit[id] so that AFTER the deck creates a
// chart, the canvas's saved data-chart-type is applied; and (2) reconciles charts
// already built at load (and shortly after) by destroying + recreating them with
// the saved type, preserving their data + options. Defensive throughout — any deck
// without a recognizable Chart.js chart is left untouched. Mirrors
// applyChartTypeToElement above; kept in plain ES5-ish JS for broad deck support.
const CHART_OVERRIDE_SOURCE = `(function(){
  function swap(canvas){
    try{
      var C=window.Chart; if(!C||!C.getChart) return;
      var desired=canvas.getAttribute('${CHART_TYPE_ATTR}'); if(!desired) return;
      var inst=C.getChart(canvas); if(!inst) return;
      var cfg=inst.config||{};
      if(cfg.type===desired) return;
      var data=cfg.data||inst.data;
      var options=cfg.options||inst.options;
      if(data&&data.datasets){for(var i=0;i<data.datasets.length;i++){if(data.datasets[i])delete data.datasets[i].type;}}
      var ctx=canvas.getContext('2d'); if(!ctx) return;
      try{inst.destroy();}catch(e){}
      try{new C(ctx,{type:desired,data:data,options:options});}
      catch(e){try{new C(ctx,{type:desired,data:data});}catch(e2){}}
    }catch(e){}
  }
  function wrap(){
    var reg=window.__chartInit; if(!reg) return;
    for(var id in reg){ if(!Object.prototype.hasOwnProperty.call(reg,id)) continue;
      var orig=reg[id];
      if(typeof orig==='function'&&!orig.__cov){
        (function(fn){var w=function(cv){fn(cv);swap(cv);};w.__cov=true;reg[id]=w;})(orig);
      }
    }
  }
  function reconcile(){
    var list=document.querySelectorAll('canvas[${CHART_TYPE_ATTR}]');
    for(var i=0;i<list.length;i++) swap(list[i]);
  }
  function run(){ wrap(); reconcile(); [100,400,1000,2500].forEach(function(d){setTimeout(reconcile,d);}); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run); else run();
})();`;
